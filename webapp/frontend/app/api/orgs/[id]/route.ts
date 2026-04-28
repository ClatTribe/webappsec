import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  name: z.string().min(2).max(80).optional(),
  llm_provider: z.string().min(1).max(120).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  // RLS organizations_owner_update only allows owners; members get 0 rows updated.
  const { data, error } = await supabase
    .from('organizations')
    .update(parsed.data)
    .eq('id', params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  if (!data)
    return NextResponse.json(
      { error: 'not allowed to update this org (owner only)' },
      { status: 403 },
    );

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.update',
    resource_type: 'organization',
    resource_id: params.id,
    metadata: parsed.data,
  });

  return NextResponse.json({ ok: true });
}
