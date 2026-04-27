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
