import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// DELETE /api/integrations/:id — revoke an integration.
// Soft-revoke (status = 'revoked'); the row stays for audit purposes.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // RLS on integrations restricts UPDATE to admin/owner; let it enforce.
  const { error, data } = await supabase
    .from('integrations')
    .update({ status: 'revoked' })
    .eq('id', params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 403 });

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: data!.org_id,
    user_id: user.id,
    action: 'integration.revoke',
    resource_type: 'integration',
    resource_id: params.id,
  });

  return NextResponse.json({ ok: true });
}
