import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Projects — Phase C of org-scale onboarding.
//
//   GET  /api/projects                    list active projects with rollup
//   POST /api/projects { name, ... }      create a project
//
// The list path reads from project_summary_v so the index page renders
// finding counts + last-scan recency in one round-trip. RLS gates
// access at the row level; no need to re-filter by org_id here.

export const dynamic = 'force-dynamic';

const PostBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
    .optional(),
  description: z.string().max(2048).optional().nullable(),
  criticality: z.enum(['tier_1', 'tier_2', 'tier_3', 'tier_4']).default('tier_2'),
  owner_user_id: z.string().uuid().optional().nullable(),
  tags: z.record(z.unknown()).default({}),
});

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('project_summary_v')
    .select(
      'project_id, slug, name, criticality, owner_user_id, tags, archived_at, target_count, last_scan_at, open_critical, open_high, open_medium, open_low, open_total',
    )
    .is('archived_at', null)
    .order('criticality', { ascending: true })
    .order('open_critical', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ projects: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  // Auto-slug from name when not provided. The DB constraint enforces
  // the shape; we do a best-effort transformation here so the API is
  // forgiving about whitespace / casing.
  const slug =
    parsed.data.slug ??
    parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  if (!slug) {
    return NextResponse.json(
      { error: 'unable to derive a valid slug from the name; set `slug` explicitly' },
      { status: 400 },
    );
  }

  const { data: row, error } = (await supabase
    .from('projects')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      slug,
      description: parsed.data.description ?? null,
      criticality: parsed.data.criticality,
      owner_user_id: parsed.data.owner_user_id ?? null,
      tags: parsed.data.tags,
      created_by: user.id,
    } as never)
    .select('id, name, slug, criticality, owner_user_id, tags, created_at')
    .single()) as unknown as {
    data: { id: string; slug: string; name: string } | null;
    error: { message: string; code?: string } | null;
  };

  if (error || !row) {
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `a project with slug "${slug}" already exists in this org` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `failed to create project: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'project.created',
    resource_type: 'project',
    resource_id: row.id,
    metadata: { name: parsed.data.name, slug: row.slug, criticality: parsed.data.criticality },
  } as never);

  return NextResponse.json({ ok: true, project: row });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
