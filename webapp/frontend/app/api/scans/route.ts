import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  targets: z.array(z.string().min(1)).min(1).max(10),
  scan_mode: z.enum(['quick', 'standard', 'deep']).default('standard'),
  scope_mode: z.enum(['auto', 'diff', 'full']).default('auto'),
  diff_base: z.string().optional(),
  instruction_text: z.string().nullable().optional(),
  integration_ids: z.array(z.string().uuid()).default([]),
});

// POST /api/scans — queue a new scan.
// 1. Verify caller has a current org and is a member with permission.
// 2. Insert scan + targets + integrations.
// 3. The pg_notify trigger from migration 4 wakes the worker.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const blocked = body.targets.filter(isInternalAddress);
  if (blocked.length > 0) {
    return NextResponse.json(
      { error: 'targets resolve to internal addresses; pick a public host', blocked },
      { status: 400 },
    );
  }

  // Pull the org_id from the user's JWT — the JWT hook (migration 2) injects it.
  const session = await supabase.auth.getSession();
  const orgId = (session.data.session?.user.app_metadata as { org_id?: string } | undefined)?.org_id
    ?? (session.data.session?.access_token
      ? JSON.parse(Buffer.from(session.data.session.access_token.split('.')[1], 'base64url').toString('utf8')).org_id
      : null);
  if (!orgId) {
    return NextResponse.json({ error: 'no org context — refresh session' }, { status: 400 });
  }

  // Verify integrations all belong to this org. RLS enforces this for the user-context client.
  if (body.integration_ids.length > 0) {
    const { data: ints, error: intErr } = await supabase
      .from('integrations')
      .select('id')
      .in('id', body.integration_ids);
    if (intErr) return NextResponse.json({ error: intErr.message }, { status: 500 });
    if (ints.length !== body.integration_ids.length) {
      return NextResponse.json({ error: 'one or more integrations not in your org' }, { status: 403 });
    }
  }

  const runName = makeRunName(body.targets[0]);

  // Insert under user-context so RLS validates org_id matches the JWT.
  const { data: scan, error: scanErr } = await supabase
    .from('scans')
    .insert({
      org_id: orgId,
      user_id: user.id,
      run_name: runName,
      status: 'queued',
      scan_mode: body.scan_mode,
      scope_mode: body.scope_mode,
      diff_base: body.diff_base ?? null,
      instruction_text: body.instruction_text ?? null,
    })
    .select()
    .single();
  if (scanErr || !scan) {
    return NextResponse.json({ error: scanErr?.message ?? 'failed to insert' }, { status: 500 });
  }

  // Insert targets and integration links. Could be done in a transaction RPC for atomicity.
  const targets = body.targets.map((value, i) => ({
    scan_id: scan.id,
    type: inferTargetType(value),
    value,
    workspace_subdir: `target_${i + 1}`,
  }));
  const { error: tgtErr } = await supabase.from('scan_targets').insert(targets);
  if (tgtErr) {
    // Best-effort cleanup; the scan row is harmless on its own (worker will fail with no targets).
    return NextResponse.json({ error: tgtErr.message }, { status: 500 });
  }

  if (body.integration_ids.length > 0) {
    const { error: linkErr } = await supabase.from('scan_integrations').insert(
      body.integration_ids.map((integration_id) => ({ scan_id: scan.id, integration_id })),
    );
    if (linkErr) {
      return NextResponse.json({ error: linkErr.message }, { status: 500 });
    }
  }

  // Audit (service role bypasses RLS).
  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'scan.start',
    resource_type: 'scan',
    resource_id: scan.id,
    metadata: { targets: body.targets, scan_mode: body.scan_mode },
  });

  return NextResponse.json({ scan_id: scan.id, run_name: runName });
}

function inferTargetType(target: string): string {
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(target) || /^git@/.test(target)) {
    return 'repository';
  }
  if (/^https?:\/\//.test(target)) return 'web_application';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) return 'ip_address';
  if (target.startsWith('./') || target.startsWith('/')) return 'local_code';
  return 'domain';
}

// Reject targets that point at the worker's own network — loopback, link-local,
// RFC1918, IPv6 ULA, and metadata endpoints. Without this an authenticated user
// can submit `http://127.0.0.1`, `http://169.254.169.254`, `http://10.x.y.z`,
// etc. as web_application targets and the scanner agent will hit those from
// inside the worker.
//
// Conservative literal check — does not resolve hostnames, so a domain that
// resolves to an internal IP (DNS rebinding) still gets through. A future
// hardening pass should add a worker-side egress firewall keyed on the
// authorized targets at scan start (Architecture.md §4.2 #12).
function isInternalAddress(value: string): boolean {
  let host = value.trim();
  // Strip scheme + path so we're left with hostname[:port].
  host = host.replace(/^https?:\/\//i, '').split('/', 1)[0].split('@').pop()!.split(':', 1)[0];
  if (!host) return false;

  // IPv6 literals come wrapped in [...].
  const v6 = host.match(/^\[(.+)\]$/)?.[1] ?? (host.includes(':') ? host : null);
  if (v6) {
    const lower = v6.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fe80:') ||              // link-local
      lower.startsWith('fc') || lower.startsWith('fd') || // ULA fc00::/7
      lower.startsWith('::ffff:127.') ||        // IPv4-mapped loopback
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:169.254.') ||
      /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./.test(lower) ||
      lower.startsWith('::ffff:192.168.')
    );
  }

  // IPv4 literal.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return false;
    return (
      o[0] === 127 ||                                   // 127.0.0.0/8 loopback
      o[0] === 10 ||                                    // 10.0.0.0/8
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||     // 172.16.0.0/12
      (o[0] === 192 && o[1] === 168) ||                 // 192.168.0.0/16
      (o[0] === 169 && o[1] === 254) ||                 // link-local + AWS/GCP metadata
      o[0] === 0 ||                                     // 0.0.0.0/8
      o[0] >= 224                                       // multicast / reserved
    );
  }

  // Hostname forms that explicitly reference the local host.
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === 'metadata.google.internal' ||
    lower === 'host.docker.internal' ||
    lower === 'kubernetes.default' ||
    lower.endsWith('.svc.cluster.local')
  );
}

function makeRunName(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}_${suffix}`;
}
