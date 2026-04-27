import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  name: z.string().min(2).max(80),
});

// POST /api/orgs — create an org and add the current user as owner.
// Used by the signup flow.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.format() }, { status: 400 });
  }

  const { name } = parsed.data;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) + '-' + Math.random().toString(36).slice(2, 6);

  const admin = createAdminClient();

  // Service-role insert because this user has no org_id JWT claim yet.
  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .insert({ name, slug, plan: 'free' })
    .select()
    .single();
  if (orgErr) return NextResponse.json({ error: orgErr.message }, { status: 500 });

  const { error: memberErr } = await admin.from('org_members').insert({
    user_id: user.id,
    org_id: org.id,
    role: 'owner',
  });
  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 });

  await admin.from('audit_log').insert({
    org_id: org.id,
    user_id: user.id,
    action: 'org.create',
    resource_type: 'organization',
    resource_id: org.id,
  });

  return NextResponse.json({ org_id: org.id, slug });
}
