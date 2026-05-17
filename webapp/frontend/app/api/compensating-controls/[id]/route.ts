import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #13 — revoke a compensating control.
//
//   DELETE /api/compensating-controls/[id]
//     body (optional): { reason?: string }
//
// Soft-delete via revoked_at — the row stays so the auditor pack
// retains "this was accepted on D1, revoked on D2 because of R."
// Hard-delete is intentionally not exposed.

const Body = z.object({
  reason: z.string().max(2048).optional().nullable(),
});

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // RLS-gated read.
  const { data: existing } = await supabase
    .from('compensating_controls')
    .select('id, org_id, framework, control_id, title, revoked_at')
    .eq('id', params.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'control not found' }, { status: 404 });
  }
  if (existing.revoked_at) {
    return NextResponse.json({ ok: true, already_revoked: true });
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('compensating_controls')
    .update({
      revoked_at: nowIso,
      revoked_by: user.id,
      revocation_reason: parsed.data.reason ?? null,
    } as never)
    .eq('id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: existing.org_id,
    user_id: user.id,
    action: 'compensating_control.revoke',
    resource_type: 'compensating_control',
    resource_id: params.id,
    metadata: {
      framework: existing.framework,
      control_id: existing.control_id,
      reason: parsed.data.reason ?? null,
    },
  } as never);

  return NextResponse.json({ ok: true, revoked_at: nowIso });
}
