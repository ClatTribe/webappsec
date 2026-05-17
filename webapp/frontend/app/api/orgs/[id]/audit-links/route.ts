// Admin-only API for managing audit share-links (migration 054).
//
// GET    /api/orgs/<id>/audit-links            — list active links for this org
// POST   /api/orgs/<id>/audit-links            — create a new link
// DELETE /api/orgs/<id>/audit-links?id=<uuid>  — revoke a link
//
// The token itself is treated as a secret: returned only at create time,
// never re-exposed on subsequent reads. Listing shows label + expiry +
// access count + first-N chars of the token for identification.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const PostBody = z.object({
  label: z.string().max(200).nullable().optional(),
  ttl_days: z.number().int().min(1).max(365).default(30),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // RLS audit_share_links_admin_read enforces admin + org match.
  const { data, error } = await supabase
    .from('audit_share_links')
    .select('id, label, token, expires_at, revoked_at, access_count, last_accessed_at, created_at')
    .eq('org_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 403 });

  // Redact the token: show prefix + length so the user can identify
  // which link is which without re-exposing the full secret.
  const sanitized = ((data ?? []) as Array<{ token: string } & Record<string, unknown>>).map(
    (row) => ({
      ...row,
      token_preview: typeof row.token === 'string' ? row.token.slice(0, 12) + '…' : '',
      token: undefined,
    }),
  );
  return NextResponse.json({ links: sanitized });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  void params; // org scope flows through the JWT → RPC; param is for URL routing only
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('create_audit_share_link', {
    p_label: parsed.data.label ?? null,
    p_ttl_days: parsed.data.ttl_days,
  } as never);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  // RPC returns TABLE → array; first row carries the token.
  const row = ((data ?? []) as Array<{
    id: string;
    token: string;
    label: string | null;
    expires_at: string;
    created_at: string;
  }>)[0];
  if (!row) {
    return NextResponse.json({ error: 'no row returned' }, { status: 500 });
  }
  return NextResponse.json(row);
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  void params;
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  const { data, error } = await supabase.rpc('revoke_audit_share_link', { p_id: id } as never);
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ ok: Boolean(data) });
}
