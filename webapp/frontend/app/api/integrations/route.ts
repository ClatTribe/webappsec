import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  type: z.enum(['github', 'gitlab', 'aws', 'azure', 'gcp', 'k8s', 'webhook', 'domain', 'okta']),
  name: z.string().min(1).max(120),
  metadata: z.record(z.unknown()).default({}),
  // Anything inside `secret_payload` is encrypted and stored in Vault.
  secret_payload: z.record(z.unknown()),
});

// POST /api/integrations — store a new integration with credentials.
// Frontend forms (AWS, K8s, etc.) call this. The OAuth callback for GitHub
// has its own route that uses the same admin pattern internally.
export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // Resolve the caller's org from JWT.
  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) return NextResponse.json({ error: 'no org context' }, { status: 400 });

  const { type, name, metadata, secret_payload } = parsed.data;

  const admin = createAdminClient();

  // 1. Create the Vault secret (service role only).
  const { data: secretId, error: secretErr } = await admin.rpc('vault_create_secret', {
    p_secret: JSON.stringify(secret_payload),
    p_name: `org_${orgId}_${type}_${Date.now()}`,
    p_description: `${type} integration: ${name}`,
  });
  if (secretErr || !secretId) {
    return NextResponse.json({ error: secretErr?.message ?? 'vault create failed' }, { status: 500 });
  }

  // 2. Insert the integration row. Use user-context client so RLS verifies org membership.
  const { data: integration, error: insertErr } = await supabase
    .from('integrations')
    .insert({
      org_id: orgId,
      type,
      name,
      metadata,
      vault_secret_id: secretId as string,
      created_by: user.id,
    })
    .select()
    .single();

  if (insertErr || !integration) {
    return NextResponse.json({ error: insertErr?.message ?? 'insert failed' }, { status: 500 });
  }

  // 3. Audit.
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'integration.create',
    resource_type: 'integration',
    resource_id: integration.id,
    metadata: { type, name },
  });

  return NextResponse.json({ id: integration.id });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
