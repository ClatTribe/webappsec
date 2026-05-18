import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET  /api/target-templates                list active templates
// POST /api/target-templates { name, ... }  create
//
// Templates are admin-only mutations (RLS enforces); reads are
// org-wide.

export const dynamic = 'force-dynamic';

const ASSET_TYPES = [
  'local_code',
  'repository',
  'web_application',
  'domain',
  'ip_address',
  'api',
  'container_image',
  'cloud_account',
] as const;

const PostBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
    .optional(),
  description: z.string().max(2048).optional().nullable(),
  asset_type: z.enum(ASSET_TYPES).optional().nullable(),
  config: z.record(z.unknown()).default({}),
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
    .from('target_templates')
    .select('id, name, slug, description, asset_type, config, tags, created_at, updated_at')
    .is('archived_at', null)
    .order('asset_type', { ascending: true, nullsFirst: true })
    .order('name');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Tack on per-template usage count so the list page can show
  // "5 targets attached" without an N+1.
  const ids = (data ?? []).map((d) => (d as { id: string }).id);
  let usageById: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: counts } = (await supabase
      .from('targets')
      .select('template_id')
      .in('template_id', ids)) as unknown as {
      data: Array<{ template_id: string }> | null;
    };
    for (const r of counts ?? []) {
      usageById[r.template_id] = (usageById[r.template_id] ?? 0) + 1;
    }
  }
  const rows = (data ?? []).map((d) => ({
    ...(d as Record<string, unknown>),
    target_count: usageById[(d as { id: string }).id] ?? 0,
  }));

  return NextResponse.json({ templates: rows });
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

  const slug =
    parsed.data.slug ??
    parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  if (!slug) {
    return NextResponse.json(
      { error: 'unable to derive a valid slug from the name' },
      { status: 400 },
    );
  }

  const { data: row, error } = (await supabase
    .from('target_templates')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      slug,
      description: parsed.data.description ?? null,
      asset_type: parsed.data.asset_type ?? null,
      config: parsed.data.config,
      tags: parsed.data.tags,
      created_by: user.id,
    } as never)
    .select('id, name, slug, asset_type, config, tags, created_at')
    .single()) as unknown as {
    data: { id: string; slug: string } | null;
    error: { message: string; code?: string } | null;
  };

  if (error || !row) {
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `a template with slug "${slug}" already exists in this org` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `create failed: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'target_template.created',
    resource_type: 'target_template',
    resource_id: row.id,
    metadata: { name: parsed.data.name, slug: row.slug, asset_type: parsed.data.asset_type },
  } as never);

  return NextResponse.json({ ok: true, template: row });
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
