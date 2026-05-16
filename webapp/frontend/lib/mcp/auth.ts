// Tier II #8 — MCP server bearer-token auth.
//
// Resolves an Authorization header to an org context (or null on any
// failure path). Used by /api/mcp/route.ts on every JSON-RPC request.
//
// Auth flow:
//   1. Pull `Authorization: Bearer <token>` from the headers.
//   2. Pre-filter by shape (cheap; avoids DB round-trip for nonsense).
//   3. SHA-256(token) → call resolve_api_key() SECURITY DEFINER RPC.
//   4. On hit: bump last_used_at via touch_api_key() (fire-and-forget;
//      we do not block the request on the audit write).

import { createAdminClient } from '@/lib/supabase/admin';
import { hashApiKey, isWellFormedApiKey } from '@/lib/api-keys';

export type McpScope = 'mcp:read' | 'mcp:scan' | 'mcp:review';

export interface McpAuthContext {
  orgId: string;
  keyId: string;
  scopes: McpScope[];
}

export async function authenticateMcpRequest(
  headers: Headers,
): Promise<McpAuthContext | null> {
  const auth = headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const presented = m[1].trim();
  if (!isWellFormedApiKey(presented)) return null;

  const hash = hashApiKey(presented);
  const admin = createAdminClient();

  // SECURITY DEFINER RPC returns rows where org_id + scopes + key_id
  // match an active, non-revoked, non-expired key. We pass the HASH,
  // never the raw key, so the secret material never appears in
  // pg_stat_statements or query logs.
  const { data, error } = (await admin.rpc('resolve_api_key', {
    p_key_hash: hash,
  } as never)) as unknown as {
    data: Array<{ org_id?: string; key_id?: string; scopes?: string[] }> | null;
    error: { message: string } | null;
  };

  if (error || !data || data.length === 0) {
    return null;
  }

  // The RPC returns SETOF — supabase-js gives us an array.
  const row = data[0];
  const orgId = row?.org_id;
  const keyId = row?.key_id;
  const scopes = (row?.scopes ?? []) as McpScope[];

  if (!orgId || !keyId) return null;

  // Fire-and-forget last_used_at bump. We deliberately don't await —
  // an authenticated call should not block on the audit write.
  admin.rpc('touch_api_key', { p_key_id: keyId } as never).then(
    () => {
      /* ok */
    },
    () => {
      /* swallow — last_used_at is best-effort */
    },
  );

  return { orgId, keyId, scopes };
}

export function hasScope(ctx: McpAuthContext, scope: McpScope): boolean {
  return ctx.scopes.includes(scope);
}
