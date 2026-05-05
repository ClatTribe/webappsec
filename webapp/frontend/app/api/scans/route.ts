import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  target_id: z.string().uuid().optional(),
  targets: z.array(z.string().min(1)).min(1).max(10),
  scan_mode: z.enum(['quick', 'standard', 'deep']).default('standard'),
  scope_mode: z.enum(['auto', 'diff', 'full']).default('auto'),
  diff_base: z.string().optional(),
  instruction_text: z.string().nullable().optional(),
  integration_ids: z.array(z.string().uuid()).default([]),
  // Engine PR #30 — passive recon mode for domain targets. Worker
  // forwards as STRIX_DNS_ONLY=1 in the sandbox env.
  dns_only: z.boolean().default(false),
  // Engine PR #117 — branch picker for repository targets. Free-form
  // ref string (branch / tag / SHA); engine forwards as `--branch`.
  // Strip server-side defensively — a stray space breaks shell escape.
  branch: z.string().trim().max(255).optional(),
  // Engine PR #113 — cost-cap self-exit gates. Both nullable;
  // null/missing/zero = "no cap" (the engine's default). Upper bounds
  // exist to keep a fat-fingered "999999" from confusing the engine,
  // but we don't enforce a per-org plan cap here — that's a future
  // billing-tier follow-up.
  max_cost: z.number().positive().max(10_000).optional(),
  max_input_tokens: z.number().int().positive().max(1_000_000_000).optional(),
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

  // Atomic create. Without this, the previous flow did three sequential
  // inserts (scans, scan_targets, scan_integrations) — each its own HTTP
  // round-trip and Postgres transaction. The `scan_queued` pg_notify fires
  // when the *first* commits, before targets are in. A fast worker can
  // claim the scan, fetch a target-less join, invoke Strix with no `-t`,
  // and silently mark it completed.
  //
  // The RPC inserts all three in one transaction; pg_notify is held until
  // commit, so the worker only ever sees fully-populated scans.
  const targetsPayload = body.targets.map((value, i) => ({
    type: inferTargetType(value),
    value,
    workspace_subdir: `target_${i + 1}`,
  }));

  const { data: scanId, error: rpcErr } = await supabase.rpc('create_scan_with_targets', {
    p_org_id: orgId,
    p_run_name: runName,
    p_scan_mode: body.scan_mode,
    p_scope_mode: body.scope_mode,
    p_diff_base: body.diff_base ?? null,
    p_instruction_text: body.instruction_text ?? null,
    p_target_id: body.target_id ?? null,
    p_targets: targetsPayload,
    p_integration_ids: body.integration_ids,
    p_dns_only: body.dns_only,
    p_branch: body.branch && body.branch.length > 0 ? body.branch : null,
    p_max_cost: body.max_cost ?? null,
    p_max_input_tokens: body.max_input_tokens ?? null,
  });
  if (rpcErr || !scanId) {
    return NextResponse.json(
      { error: rpcErr?.message ?? 'failed to create scan' },
      { status: 500 },
    );
  }

  // Audit (service role bypasses RLS). Stays out of the RPC because audit_log
  // RLS forbids authenticated inserts.
  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'scan.start',
    resource_type: 'scan',
    resource_id: scanId,
    metadata: { targets: body.targets, scan_mode: body.scan_mode },
  });

  return NextResponse.json({ scan_id: scanId, run_name: runName });
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
