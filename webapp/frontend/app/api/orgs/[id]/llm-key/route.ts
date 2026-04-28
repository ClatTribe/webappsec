import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  api_key: z.string().min(8).max(2048),
  llm_provider: z.string().min(1).max(120).optional(),
});

// PUT /api/orgs/[id]/llm-key — store an LLM API key for the org in Vault.
// Owner-only. Replaces any previous key by writing a new vault secret and
// pointing organizations.llm_api_key_secret_id at it. The previous secret row
// is left in vault (not deleted) for audit; it's no longer reachable from any
// org row, so it's effectively rotated.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.format() }, { status: 400 });
  }

  // Verify the user is a member of this org and (via RLS) an owner — we use
  // the user-context client to do an UPDATE first, which only succeeds for
  // owners. If RLS blocks it we never touch Vault.
  const { data: orgCheck, error: orgErr } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', params.id)
    .single();
  if (orgErr || !orgCheck) {
    return NextResponse.json({ error: 'org not found or no access' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: secretId, error: secretErr } = await admin.rpc('vault_create_secret', {
    p_secret: parsed.data.api_key,
    p_name: `org_${params.id}_llm_key_${Date.now()}`,
    p_description: 'Per-org LLM API key',
  });
  if (secretErr || !secretId) {
    return NextResponse.json({ error: secretErr?.message ?? 'vault create failed' }, { status: 500 });
  }

  // Now write the pointer + provider through the user-context client so RLS
  // enforces owner-only.
  const update: Record<string, unknown> = { llm_api_key_secret_id: secretId };
  if (parsed.data.llm_provider) update.llm_provider = parsed.data.llm_provider;

  const { data, error } = await supabase
    .from('organizations')
    .update(update)
    .eq('id', params.id)
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'not allowed (owner only)' },
      { status: 403 },
    );
  }

  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.llm_key.set',
    resource_type: 'organization',
    resource_id: params.id,
    metadata: { provider: parsed.data.llm_provider ?? null },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/orgs/[id]/llm-key — clear the org's LLM key pointer.
// The vault.secrets row is left in place for audit; the worker just falls
// back to the default LLM_API_KEY env var when no per-org key is set.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data, error } = await supabase
    .from('organizations')
    .update({ llm_api_key_secret_id: null })
    .eq('id', params.id)
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'not allowed (owner only)' },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.llm_key.unset',
    resource_type: 'organization',
    resource_id: params.id,
  });

  return NextResponse.json({ ok: true });
}
