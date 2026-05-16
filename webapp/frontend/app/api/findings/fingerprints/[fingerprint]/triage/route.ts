import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #11 — bulk-triage all OPEN occurrences sharing a fingerprint.
//
//   POST /api/findings/fingerprints/[fingerprint]/triage
//     body: { status: 'fixed'|'false_positive'|'wont_fix'|'triaged_real'|'open',
//             reason?: string }
//
// Calls the triage_finding_fingerprint() RPC (SECURITY INVOKER, so
// RLS enforces the org boundary). Returns the count of rows actually
// updated — the UI uses this for "marked 8 of 12 (4 already triaged)".
//
// We deliberately do not expose a "delete" path here. Bulk triage is
// a forward op only. Soft-delete / reset is a separate per-finding
// operation in the regular Findings UI.

const Body = z.object({
  status: z.enum(['fixed', 'false_positive', 'wont_fix', 'triaged_real', 'open']),
  reason: z.string().max(2048).optional().nullable(),
});

export async function POST(
  req: Request,
  { params }: { params: { fingerprint: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const fingerprint = decodeURIComponent(params.fingerprint).trim();
  if (!fingerprint) {
    return NextResponse.json({ error: 'fingerprint required' }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // wont_fix requires a reason — matches the per-finding constraint
  // in the regular triage UI.
  if (parsed.data.status === 'wont_fix' && !parsed.data.reason?.trim()) {
    return NextResponse.json(
      { error: 'a reason is required when bulk-marking wont_fix' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('triage_finding_fingerprint', {
    p_fingerprint: fingerprint,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason ?? null,
  } as never);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const updated = typeof data === 'number' ? data : Number(data) || 0;

  // Audit log — we use the admin client because audit_log rows are
  // append-only from any user-context call; same pattern as the
  // per-finding triage routes.
  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    user_id: user.id,
    action: 'finding.bulk_triage_by_fingerprint',
    resource_type: 'fingerprint',
    resource_id: fingerprint,
    metadata: {
      status: parsed.data.status,
      reason: parsed.data.reason ?? null,
      updated_count: updated,
    },
  } as never);

  return NextResponse.json({
    ok: true,
    updated_count: updated,
    status: parsed.data.status,
    fingerprint,
  });
}
