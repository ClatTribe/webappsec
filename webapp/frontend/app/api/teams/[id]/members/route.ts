import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST   /api/teams/[id]/members  { user_id, role? }  add member
// DELETE /api/teams/[id]/members  { user_id }         remove member

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PostBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['member', 'lead']).default('member'),
});

const DeleteBody = z.object({
  user_id: z.string().uuid(),
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
  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
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
  const { error } = await supabase.from('team_members').insert({
    team_id: teamId,
    user_id: parsed.data.user_id,
    role: parsed.data.role,
    added_by: user.id,
  } as never);
  if (error) {
    // 23505 = already-a-member; treat as idempotent success.
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ ok: true, idempotent: true });
    }
    return NextResponse.json(
      { error: `add member failed: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
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
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', parsed.data.user_id);
  if (error) {
    return NextResponse.json(
      { error: `remove member failed: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
