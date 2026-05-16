import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mintApiKey } from '@/lib/api-keys';

// Tier II #8 — API key management.
//
//   GET  /api/keys                list the caller's org's keys (RLS-gated)
//   POST /api/keys  { name }      mint a new key; returns full key ONCE
//
// Revocation lives at /api/keys/[id]/route.ts (DELETE).
//
// Only org admins/owners can mint — that's enforced server-side here
// AND in the RLS policy on api_keys (defence-in-depth so a row that
// somehow gets POSTed via a leaked service-role key still bounces).

const PostBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.enum(['mcp:read', 'mcp:scan', 'mcp:review']))
    .min(1)
    .default(['mcp:read', 'mcp:scan', 'mcp:review']),
  /** Optional ISO-8601 expiry. Default: no expiry (caller revokes
   *  explicitly when laptop / CI job retires). */
  expires_at: z.string().datetime().optional().nullable(),
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
    .from('api_keys')
    .select(
      'id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at, created_by',
    )
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ keys: data ?? [] });
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

  // Resolve org from JWT. Same readJwtClaim pattern as /api/targets.
  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  // Enforce admin/owner role here. RLS does too, but the error
  // message is clearer from the route.
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json(
      { error: 'only org owners / admins can mint API keys' },
      { status: 403 },
    );
  }

  // Mint, hash, persist.
  const { fullKey, prefix, hash } = mintApiKey();

  // We use the user-context client for the insert — RLS verifies the
  // {org_id, created_by, role} triple.
  const { data: row, error } = (await supabase
    .from('api_keys')
    .insert({
      org_id: orgId,
      created_by: user.id,
      name: parsed.data.name,
      key_prefix: prefix,
      key_hash: hash,
      scopes: parsed.data.scopes,
      expires_at: parsed.data.expires_at ?? null,
    } as never)
    .select('id, name, key_prefix, scopes, expires_at, created_at')
    .single()) as unknown as { data: { id: string; name: string; key_prefix: string; scopes: string[]; expires_at: string | null; created_at: string } | null; error: { message: string } | null };

  if (error || !row) {
    return NextResponse.json(
      { error: `failed to create key: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  // Audit log — same pattern as the targets route.
  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'api_key.create',
    resource_type: 'api_key',
    resource_id: row.id,
    metadata: { name: row.name, prefix: row.key_prefix },
  } as never);

  return NextResponse.json({
    ok: true,
    key: row,
    // SHOWN ONLY ONCE — the caller must surface this in the UI and
    // make clear it's not retrievable later. We do not include it on
    // any subsequent GET.
    full_key: fullKey,
  });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
