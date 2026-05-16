import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Tier I #6 — comments thread per finding.
//
//   GET  /api/findings/[id]/comments      list (RLS-gated)
//   POST /api/findings/[id]/comments      insert
//
// Append-only audit trail (engine-side TrustNote / SOC 2 audit pack
// requirement — deletes are soft, see migration 065). All mutations
// run as the user context (createClient) so RLS enforces the org
// boundary; no service-role escalation needed.

const MAX_BODY_LEN = 16_384;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // RLS on finding_comments only allows reads when the row's org_id
  // matches the JWT's current_org_id — so a successful select implicitly
  // proves visibility on the parent finding too.
  const { data, error } = await supabase
    .from('finding_comments')
    .select('id, finding_id, user_id, body, created_at, updated_at, deleted_at')
    .eq('finding_id', params.id)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Pull author display names in one round-trip. Soft-deleted rows still
  // surface, but with body replaced by the audit placeholder — the
  // auditor pack must not show a memory hole.
  const userIds = [...new Set((data ?? []).map((r) => r.user_id))];
  const { data: profiles } = userIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', userIds)
    : { data: [] };
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name as string | null]));

  const items = (data ?? []).map((r) => ({
    id: r.id,
    finding_id: r.finding_id,
    user_id: r.user_id,
    author_name: nameById.get(r.user_id) ?? null,
    body: r.deleted_at ? '[redacted]' : r.body,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  }));

  return NextResponse.json({ comments: items });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const text: string = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'comment body required' }, { status: 400 });
  }
  if (text.length > MAX_BODY_LEN) {
    return NextResponse.json(
      { error: `comment too long (max ${MAX_BODY_LEN} chars)` },
      { status: 400 },
    );
  }

  // Resolve org_id from the finding (RLS-gated). We don't trust a
  // client-supplied org_id — the row's RLS policies guarantee the user
  // can only fetch findings in their current org.
  const { data: finding, error: findingErr } = await supabase
    .from('findings')
    .select('id, org_id')
    .eq('id', params.id)
    .single();
  if (findingErr || !finding) {
    return NextResponse.json(
      { error: 'finding not found or no access' },
      { status: 404 },
    );
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('finding_comments')
    .insert({
      finding_id: finding.id,
      org_id: finding.org_id,
      user_id: user.id,
      body: text,
    })
    .select('id, finding_id, user_id, body, created_at, updated_at, deleted_at')
    .single();

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'failed to insert comment' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    comment: {
      ...inserted,
      author_name:
        (
          await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', user.id)
            .single()
        ).data?.full_name ?? null,
    },
  });
}
