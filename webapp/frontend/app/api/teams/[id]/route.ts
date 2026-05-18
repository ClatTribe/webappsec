import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2048).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0);

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const isUuid = UUID_RE.test(params.id);
  const q = supabase
    .from('teams')
    .select('id, name, slug, description, created_at, updated_at')
    .is('archived_at', null);
  const { data: team } = (await (isUuid
    ? q.eq('id', params.id)
    : q.eq('slug', params.id)
  ).maybeSingle()) as unknown as { data: { id: string } | null };
  if (!team) {
    return NextResponse.json({ error: 'team not found' }, { status: 404 });
  }

  // Members + targets in parallel.
  const [{ data: members }, { data: targetLinks }] = await Promise.all([
    supabase
      .from('team_members')
      .select('user_id, role, added_at')
      .eq('team_id', team.id),
    supabase
      .from('team_targets')
      .select('target_id, added_at')
      .eq('team_id', team.id),
  ]);

  // Hydrate target rows + member profiles via the existing surfaces.
  const targetIds = ((targetLinks ?? []) as Array<{ target_id: string }>).map(
    (r) => r.target_id,
  );
  let attachedTargets: Array<{
    id: string;
    name: string;
    type: string;
    value: string;
  }> = [];
  if (targetIds.length > 0) {
    const { data: ts } = (await supabase
      .from('targets')
      .select('id, name, type, value')
      .in('id', targetIds)) as unknown as {
      data: Array<{ id: string; name: string; type: string; value: string }> | null;
    };
    attachedTargets = ts ?? [];
  }

  return NextResponse.json({
    team,
    members: members ?? [],
    targets: attachedTargets,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }
  const isUuid = UUID_RE.test(params.id);
  const q = supabase.from('teams').update(parsed.data as never);
  const { data, error } = (await (isUuid
    ? q.eq('id', params.id)
    : q.eq('slug', params.id)
  )
    .select('id, name, slug')
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'team not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const isUuid = UUID_RE.test(params.id);
  const q = supabase
    .from('teams')
    .update({ archived_at: new Date().toISOString() } as never);
  const { data, error } = (await (isUuid
    ? q.eq('id', params.id)
    : q.eq('slug', params.id)
  )
    .select('id')
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'team not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
