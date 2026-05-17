// Owner-only API for the Living Trust Page (migration 047) settings.
//
// The trust-page itself is public and gated by organizations.trust_page_enabled.
// Until #87 this flag was SQL-only; this route exposes a settings-page
// affordance so a vibe-coded founder can flip it on the moment a
// prospect asks "are you SOC 2 ready?".

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  subtitle: z.string().max(280).nullable().optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // RLS scopes this to caller's org. Returns null if the row isn't visible.
  const { data, error } = await supabase
    .from('organizations')
    .select('id, slug, trust_page_enabled, trust_page_subtitle, trust_page_published_at')
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json(data);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  // Project to DB column names.
  const update: Record<string, unknown> = {};
  if (parsed.data.enabled !== undefined) update.trust_page_enabled = parsed.data.enabled;
  if (parsed.data.subtitle !== undefined) update.trust_page_subtitle = parsed.data.subtitle;

  // RLS organizations_owner_update only allows owners; non-owners get 0 rows updated.
  const { data, error } = await supabase
    .from('organizations')
    .update(update as never)
    .eq('id', params.id)
    .select('id, slug, trust_page_enabled, trust_page_subtitle, trust_page_published_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  if (!data) {
    return NextResponse.json(
      { error: 'not allowed to update this org (owner only)' },
      { status: 403 },
    );
  }

  // Audit-log every change. Service role because the org's RLS only lets
  // admins/owners read the audit_log; the action itself is authorised
  // above. Same pattern as /api/orgs/[id]/route.ts.
  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.trust_page_update',
    resource_type: 'organization',
    resource_id: params.id,
    metadata: update,
  } as never);

  return NextResponse.json(data);
}
