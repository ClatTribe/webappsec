import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST   /api/teams/[id]/targets  { target_ids: [...] }   attach targets
// DELETE /api/teams/[id]/targets  { target_ids: [...] }   detach

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  target_ids: z.array(z.string().uuid()).min(1).max(500),
});

async function resolveTeamId(
  supabase: ReturnType<typeof createClient>,
  param: string,
): Promise<string | null> {
  if (UUID_RE.test(param)) return param;
  const { data } = await supabase
    .from('teams')
    .select('id')
    .eq('slug', param)
    .is('archived_at', null)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
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
  const teamId = await resolveTeamId(supabase, params.id);
  if (!teamId) {
    return NextResponse.json({ error: 'team not found' }, { status: 404 });
  }
  // Upsert via insert with on-conflict-do-nothing semantics — supabase
  // doesn't expose that directly; do per-row inserts and tolerate
  // 23505. Bounded to 500 by the zod schema.
  let attached = 0;
  for (const tid of parsed.data.target_ids) {
    const { error } = await supabase.from('team_targets').insert({
      team_id: teamId,
      target_id: tid,
      added_by: user.id,
    } as never);
    if (error && (error as { code?: string }).code !== '23505') {
      return NextResponse.json(
        { error: `attach failed at target ${tid}: ${error.message}` },
        { status: 500 },
      );
    }
    if (!error) attached += 1;
  }
  return NextResponse.json({ ok: true, attached });
}

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
  const teamId = await resolveTeamId(supabase, params.id);
  if (!teamId) {
    return NextResponse.json({ error: 'team not found' }, { status: 404 });
  }
  const { error } = await supabase
    .from('team_targets')
    .delete()
    .eq('team_id', teamId)
    .in('target_id', parsed.data.target_ids);
  if (error) {
    return NextResponse.json(
      { error: `detach failed: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
