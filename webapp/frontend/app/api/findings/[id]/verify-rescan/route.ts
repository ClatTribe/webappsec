import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// POST /api/findings/[id]/verify-rescan — fix-verify targeted rescan.
//
// Wishlist §9.3 row 2 / Tier A. The engineer's "I fixed it; verify"
// loop: a single click on a finding's casefile creates a new narrow
// scan focused on confirming whether the vulnerability still exists.
//
// Flow:
//   1. Verify the finding is visible to the user (user-context client +
//      RLS). 404 on missing/cross-org.
//   2. Read the source scan's target so the new scan inherits the
//      same scope.
//   3. Compose an instruction text that gives the agent the original
//      finding's title + CWE + severity + endpoint, asking it to
//      report a clean "still exploitable" / "no longer present"
//      verdict.
//   4. Call create_scan_with_targets to spawn the scan (quick mode —
//      this is verification, not exhaustive).
//   5. Admin-client UPDATE flips `scans.verifying_finding_id` so the
//      new scan's page can surface a "Verifying finding: ..." badge.
//   6. Audit log + return the new scan id for the redirect.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // 1. Visibility-gated read of the finding + its source scan's target.
  //    The findings table joins to scans for org/target context; both
  //    are protected by RLS so a successful select means we're allowed
  //    to triage this finding.
  const { data: finding, error: findingErr } = await supabase
    .from('findings')
    .select(`
      id, org_id, scan_id, title, severity, cwe, cve, endpoint, target, method,
      scans!inner ( id, org_id, target_id, scan_mode, scope_mode )
    `)
    .eq('id', params.id)
    .single();
  if (findingErr || !finding) {
    return NextResponse.json(
      { error: 'finding not found or no access' },
      { status: 404 },
    );
  }

  // The join shape from supabase-js puts the related row under the
  // alias key `scans` (or sometimes as an array — depends on the
  // version). We normalise both shapes.
  type SourceScan = {
    id: string;
    org_id: string;
    target_id: string | null;
    scan_mode: string;
    scope_mode: string | null;
  };
  const sourceScanRaw = (finding as unknown as { scans?: SourceScan | SourceScan[] }).scans;
  const sourceScan: SourceScan | null = Array.isArray(sourceScanRaw)
    ? sourceScanRaw[0] ?? null
    : sourceScanRaw ?? null;
  if (!sourceScan) {
    return NextResponse.json(
      { error: 'source scan missing — cannot verify' },
      { status: 422 },
    );
  }

  // 2. Resolve the target row to get the value we'll re-scan.
  let targetValue: string | null = null;
  if (sourceScan.target_id) {
    const { data: target } = await supabase
      .from('targets')
      .select('value')
      .eq('id', sourceScan.target_id)
      .single();
    targetValue = (target as { value: string } | null)?.value ?? null;
  }
  // Fall back to the finding's own endpoint/target field if the
  // target row is gone or wasn't linked. The verify scan still
  // needs at least one target string for create_scan_with_targets
  // to accept the body.
  if (!targetValue) {
    targetValue = finding.endpoint ?? finding.target ?? null;
  }
  if (!targetValue) {
    return NextResponse.json(
      { error: 'no target to verify against — finding has no endpoint or scan target' },
      { status: 422 },
    );
  }

  // 3. Compose the focused instruction. We name the original finding
  //    by its title + CWE + severity + endpoint so the agent has the
  //    full context without us re-emitting the entire markdown
  //    description (which can be large).
  const cweStr = finding.cwe ? ` (CWE-${String(finding.cwe).replace(/^cwe-?/i, '')})` : '';
  const cveStr = finding.cve ? ` / ${finding.cve}` : '';
  const sevStr = finding.severity ? ` [${finding.severity}]` : '';
  const epStr = finding.endpoint
    ? `\nAffected endpoint: ${finding.method ? `${finding.method} ` : ''}${finding.endpoint}`
    : '';
  const instruction = [
    `Verify whether a previously reported vulnerability is still exploitable.`,
    `Original finding${sevStr}: ${finding.title}${cweStr}${cveStr}.${epStr}`,
    `If the vulnerability is no longer reproducible, report a clean "no longer present" verdict.`,
    `If it still reproduces, emit the finding so cross-scan dedup links it to the original.`,
  ].join('\n');

  // 4. Spawn the new scan. We keep the same scope_mode the original
  //    used (auto/diff/full) so the operator's intent isn't lost,
  //    but always run in quick mode — this is verification, not a
  //    fresh exhaustive sweep.
  const runName = `verify: ${finding.title}`.slice(0, 200);
  const { data: scanId, error: rpcErr } = await supabase.rpc('create_scan_with_targets', {
    p_org_id: sourceScan.org_id,
    p_run_name: runName,
    p_scan_mode: 'quick',
    p_scope_mode: sourceScan.scope_mode ?? 'auto',
    p_diff_base: null,
    p_instruction_text: instruction,
    p_target_id: sourceScan.target_id ?? null,
    p_targets: [
      {
        type: inferTargetType(targetValue),
        value: targetValue,
        workspace_subdir: 'target_1',
      },
    ],
    p_integration_ids: [],
    p_dns_only: false,
    p_branch: null,
    p_max_cost: null,
    p_max_input_tokens: null,
    p_imports: null,
  });
  if (rpcErr || !scanId) {
    return NextResponse.json(
      { error: rpcErr?.message ?? 'failed to create verify scan' },
      { status: 500 },
    );
  }

  // 5. Link the new scan back to the finding so the scan page can
  //    render the "Verifying finding: <title>" badge. Service role
  //    because the column isn't in any RLS write policy.
  const admin = createAdminClient();
  await admin
    .from('scans')
    .update({ verifying_finding_id: finding.id })
    .eq('id', scanId);

  // 6. Audit. Same closed-enum action shape as the other audit_log
  //    entries (org.secret.set, scan.start, etc.) — useful for the
  //    future "verification history" UI on the FindingCard.
  await admin.from('audit_log').insert({
    org_id: sourceScan.org_id,
    user_id: user.id,
    action: 'finding.verify_rescan',
    resource_type: 'finding',
    resource_id: finding.id,
    metadata: { new_scan_id: scanId, target: targetValue },
  });

  return NextResponse.json({ scan_id: scanId });
}

// Lightweight target-type inference. Mirrors the shape of the
// equivalent helper in /api/scans/route.ts; kept inline here to
// avoid a cross-route import for what's effectively boilerplate.
function inferTargetType(value: string): string {
  if (/^https?:\/\//.test(value)) return 'web_application';
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) return 'domain';
  if (/^\d+(\.\d+){3}(\/\d+)?$/.test(value)) return 'ip_address';
  if (/^[0-9a-f:]+(\/\d+)?$/i.test(value)) return 'ip_address';
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(value)) return 'repository';
  return 'web_application';
}
