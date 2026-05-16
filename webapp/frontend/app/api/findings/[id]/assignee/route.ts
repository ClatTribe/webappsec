import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Tier I #6 — assignee + due-date mutation for a finding.
//
//   PATCH /api/findings/[id]/assignee   body: { assignee_id?, due_at?, clear? }
//
// Behaviours:
//   - assignee_id only        → just set the owner; auto-fill due_at if
//                                missing using the severity SLA below.
//   - assignee_id + due_at    → both are taken as-is.
//   - clear: true             → null out assignee_id + due_at + sla tier.
//   - assignee_id must be a member of the finding's org_id (we cross-
//     check org_members to prevent assigning to a stranger).
//
// Severity SLAs mirror the column comment in migration 065:
//   critical=7d, high=14d, medium=30d, low=90d, info=180d.

const SEVERITY_SLA_DAYS: Record<string, number> = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 90,
  info: 180,
};

interface PatchBody {
  assignee_id?: string | null;
  due_at?: string | null;
  clear?: boolean;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body: PatchBody = await req.json().catch(() => ({}));

  // Visibility-gated read so we can (a) error 404 on cross-org and (b)
  // use the finding's severity to auto-fill due_at when the caller
  // didn't pass one.
  const { data: finding, error: findingErr } = await supabase
    .from('findings')
    .select('id, org_id, severity, due_at, assignee_id')
    .eq('id', params.id)
    .single();
  if (findingErr || !finding) {
    return NextResponse.json(
      { error: 'finding not found or no access' },
      { status: 404 },
    );
  }

  if (body.clear) {
    const { error } = await supabase
      .from('findings')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ assignee_id: null, due_at: null, sla_severity_tier: null } as any)
      .eq('id', finding.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, cleared: true });
  }

  if (!body.assignee_id) {
    return NextResponse.json(
      { error: 'assignee_id required (or pass clear:true to unset)' },
      { status: 400 },
    );
  }

  // Cross-check the candidate assignee belongs to the finding's org.
  // RLS already scopes org_members to current_org_id, so this select
  // returning a row means: (a) the assignee is a member and (b) the
  // current user shares the same org_id.
  const { data: member } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', finding.org_id)
    .eq('user_id', body.assignee_id)
    .maybeSingle();
  if (!member) {
    return NextResponse.json(
      { error: 'assignee is not a member of this org' },
      { status: 400 },
    );
  }

  // Compute due_at. Caller-supplied wins; otherwise default by SLA.
  // We do *not* overwrite an existing due_at when the caller didn't
  // pass one — a deliberate due-date from a prior triage outranks the
  // default.
  let dueAt: string | null | undefined = body.due_at;
  let slaTier: string | null = null;
  if (dueAt === undefined) {
    if (finding.due_at) {
      dueAt = undefined; // leave column alone
    } else {
      const days = SEVERITY_SLA_DAYS[finding.severity ?? 'medium'] ?? 30;
      const d = new Date(Date.now() + days * 86_400_000);
      dueAt = d.toISOString();
      slaTier = finding.severity ?? null;
    }
  }

  const update: Record<string, unknown> = { assignee_id: body.assignee_id };
  if (dueAt !== undefined) update.due_at = dueAt;
  if (slaTier !== null) update.sla_severity_tier = slaTier;

  const { error } = await supabase
    .from('findings')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(update as any)
    .eq('id', finding.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    assignee_id: body.assignee_id,
    due_at: dueAt ?? finding.due_at ?? null,
    sla_severity_tier: slaTier ?? finding.severity ?? null,
  });
}
