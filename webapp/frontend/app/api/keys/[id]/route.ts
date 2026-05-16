import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #8 — revoke an API key.
//
//   DELETE /api/keys/[id]
//
// Soft-delete via revoked_at — the row stays so the audit log retains
// "this key was used N times before being revoked." The MCP resolver
// already excludes revoked rows, so a subsequent MCP request from a
// revoked key gets a 401 immediately.

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // RLS lets the user only see/update their org's rows; the role
  // check in the policy enforces admin/owner.
  const { data: existing } = await supabase
    .from('api_keys')
    .select('id, org_id, name, key_prefix, revoked_at')
    .eq('id', params.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'key not found' }, { status: 404 });
  }
  if (existing.revoked_at) {
    return NextResponse.json({ ok: true, already_revoked: true });
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: nowIso, revoked_by: user.id } as never)
    .eq('id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: existing.org_id,
    user_id: user.id,
    action: 'api_key.revoke',
    resource_type: 'api_key',
    resource_id: params.id,
    metadata: { name: existing.name, prefix: existing.key_prefix },
  } as never);

  return NextResponse.json({ ok: true, revoked_at: nowIso });
}
