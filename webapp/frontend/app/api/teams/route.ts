import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET  /api/teams                  list active teams in caller's org
// POST /api/teams { name, ... }    create a team (admin-only)

export const dynamic = 'force-dynamic';

const PostBody = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  description: z.string().max(2048).optional().nullable(),
});

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data: teams, error } = await supabase
    .from('teams')
    .select('id, name, slug, description, created_at, updated_at')
    .is('archived_at', null)
    .order('name');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Member + target counts batched per team so the index page renders
  // useful chips without N+1 lookups.
  const ids = (teams ?? []).map((t) => (t as { id: string }).id);
  let memberCount: Record<string, number> = {};
  let targetCount: Record<string, number> = {};
  if (ids.length > 0) {
    const [{ data: members }, { data: tt }] = await Promise.all([
      supabase.from('team_members').select('team_id').in('team_id', ids),
      supabase.from('team_targets').select('team_id').in('team_id', ids),
    ]);
    for (const r of (members ?? []) as Array<{ team_id: string }>) {
      memberCount[r.team_id] = (memberCount[r.team_id] ?? 0) + 1;
    }
    for (const r of (tt ?? []) as Array<{ team_id: string }>) {
      targetCount[r.team_id] = (targetCount[r.team_id] ?? 0) + 1;
    }
  }
  const rows = (teams ?? []).map((t) => ({
    ...(t as Record<string, unknown>),
    member_count: memberCount[(t as { id: string }).id] ?? 0,
    target_count: targetCount[(t as { id: string }).id] ?? 0,
  }));
  return NextResponse.json({ teams: rows });
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
    .from('teams')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      slug,
      description: parsed.data.description ?? null,
      created_by: user.id,
    } as never)
    .select('id, name, slug')
    .single()) as unknown as {
    data: { id: string; slug: string } | null;
    error: { message: string; code?: string } | null;
  };

  if (error || !row) {
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `a team with slug "${slug}" already exists in this org` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `create failed: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  // Auto-add the creator as a lead — convenience.
  await supabase.from('team_members').insert({
    team_id: row.id,
    user_id: user.id,
    role: 'lead',
    added_by: user.id,
  } as never);

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'team.created',
    resource_type: 'team',
    resource_id: row.id,
    metadata: { name: parsed.data.name, slug: row.slug },
  } as never);

  return NextResponse.json({ ok: true, team: row });
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
