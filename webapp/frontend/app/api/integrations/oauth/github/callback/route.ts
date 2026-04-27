import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyOAuthState } from '@/lib/oauth';

// GET /api/integrations/oauth/github/callback
// 1. Verify state token (CSRF + carries org_id + user_id).
// 2. Exchange code for access_token + refresh_token.
// 3. Fetch user info to display in UI.
// 4. Create vault secret + integration row + audit log.
// 5. Redirect back to /integrations.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateToken = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/integrations?error=${encodeURIComponent(error)}`, req.url));
  }
  if (!code || !stateToken) {
    return NextResponse.redirect(new URL('/integrations?error=missing_code', req.url));
  }

  let state;
  try {
    state = verifyOAuthState(stateToken);
  } catch {
    return NextResponse.redirect(new URL('/integrations?error=invalid_state', req.url));
  }
  if (state.type !== 'github') {
    return NextResponse.redirect(new URL('/integrations?error=wrong_type', req.url));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'github oauth not configured' }, { status: 500 });
  }

  // Exchange code for tokens.
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) {
    return NextResponse.redirect(new URL('/integrations?error=token_exchange', req.url));
  }

  // Fetch user info.
  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      'User-Agent': 'strix-webapp',
    },
  });
  const ghUser = await ghUserRes.json();

  // Persist via admin client (service role).
  const admin = createAdminClient();

  const { data: secretId, error: secretErr } = await admin.rpc('vault_create_secret', {
    p_secret: JSON.stringify({
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token ?? null,
      scope: tokenJson.scope ?? null,
      token_type: tokenJson.token_type ?? null,
    }),
    p_name: `org_${state.orgId}_github_${ghUser.login}_${Date.now()}`,
    p_description: `GitHub integration for @${ghUser.login}`,
  });
  if (secretErr || !secretId) {
    return NextResponse.redirect(new URL('/integrations?error=vault_failed', req.url));
  }

  const { data: integration, error: insertErr } = await admin
    .from('integrations')
    .insert({
      org_id: state.orgId,
      type: 'github',
      name: `GitHub (${ghUser.login})`,
      metadata: { login: ghUser.login, avatar_url: ghUser.avatar_url, html_url: ghUser.html_url },
      vault_secret_id: secretId as string,
      created_by: state.userId,
    })
    .select()
    .single();
  if (insertErr || !integration) {
    return NextResponse.redirect(new URL('/integrations?error=insert_failed', req.url));
  }

  await admin.from('audit_log').insert({
    org_id: state.orgId,
    user_id: state.userId,
    action: 'integration.create',
    resource_type: 'integration',
    resource_id: integration.id,
    metadata: { type: 'github', login: ghUser.login },
  });

  return NextResponse.redirect(new URL('/integrations?connected=github', req.url));
}
