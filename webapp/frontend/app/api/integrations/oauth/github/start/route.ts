import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { signOAuthState } from '@/lib/oauth';

// GET /api/integrations/oauth/github/start
// Redirects the user to GitHub's OAuth consent page with a signed state token.
export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', req.url));

  const sess = await supabase.auth.getSession();
  const token = sess.data.session?.access_token;
  const orgId = token ? readJwtClaim(token, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  const state = signOAuthState({ orgId, userId: user.id, type: 'github' });
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'GITHUB_CLIENT_ID not set' }, { status: 500 });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  url.searchParams.set(
    'redirect_uri',
    `${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'}/api/integrations/oauth/github/callback`,
  );

  return NextResponse.redirect(url);
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
