// HMAC-signed OAuth state tokens for the integration OAuth flow.
// Encodes (org_id, user_id, redirect_to, nonce, expires_at) and verifies on callback.

import 'server-only';
import crypto from 'crypto';

const ALG = 'sha256';

function getSecret(): Buffer {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET must be set');
  return Buffer.from(secret, 'utf8');
}

export interface OAuthStatePayload {
  orgId: string;
  userId: string;
  type: 'github' | 'gitlab';
  redirectTo?: string;
}

export function signOAuthState(payload: OAuthStatePayload, ttlSeconds = 600): string {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const json = JSON.stringify(body);
  const data = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac(ALG, getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyOAuthState(token: string): OAuthStatePayload {
  const [data, sig] = token.split('.');
  if (!data || !sig) throw new Error('malformed state token');

  const expected = crypto.createHmac(ALG, getSecret()).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('state token signature mismatch');
  }

  const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (body.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('state token expired');
  }
  return body as OAuthStatePayload;
}
