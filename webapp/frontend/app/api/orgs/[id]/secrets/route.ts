import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Closed enum mirrors migration 028's check constraint. Adding a new
// supported key requires a coordinated change here + the migration +
// the worker's _build_env forwarding map.
const KEY_NAMES = [
  'STRIX_GITHUB_TOKEN',
  'STRIX_BING_KEY',
  'STRIX_SECURITYTRAILS_KEY',
  'STRIX_VIRUSTOTAL_KEY',
  'STRIX_VIEWDNS_KEY',
] as const;

const PutBody = z.object({
  key: z.enum(KEY_NAMES),
  value: z.string().min(8).max(4096),
});

const DeleteBody = z.object({
  key: z.enum(KEY_NAMES),
});

// PUT /api/orgs/[id]/secrets — set one of the org's STRIX_* keys.
// Mirrors the existing /llm-key flow: vault.create_secret → store the
// returned secret_id pointer in org_secrets via the user-context client
// (RLS policy `org_secrets_admin_write` enforces owner/admin).
//
// The previous secret row for the same (org_id, key) is left in vault
// for audit; the upsert just overwrites the pointer.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // Verify the org is visible to this user (RLS); if not, 403.
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
    p_secret: parsed.data.value,
    p_name: `org_${params.id}_${parsed.data.key.toLowerCase()}_${Date.now()}`,
    p_description: `Per-org Strix key: ${parsed.data.key}`,
  });
  if (secretErr || !secretId) {
    return NextResponse.json(
      { error: secretErr?.message ?? 'vault create failed' },
      { status: 500 },
    );
  }

  // Upsert through the user-context client so the RLS policy enforces
  // owner+admin. RLS rejection → "not allowed" 403.
  const { data, error } = await supabase
    .from('org_secrets')
    .upsert(
      {
        org_id: params.id,
        key: parsed.data.key,
        secret_id: secretId,
        set_by: user.id,
        set_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,key' },
    )
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'not allowed (owner/admin only)' },
      { status: 403 },
    );
  }

  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.secret.set',
    resource_type: 'org_secret',
    resource_id: parsed.data.key,
    metadata: { key: parsed.data.key },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/orgs/[id]/secrets — clear one of the org's STRIX_* keys.
// Vault row is left in place for audit; the worker just stops forwarding
// that env var to the sandbox.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = DeleteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('org_secrets')
    .delete()
    .eq('org_id', params.id)
    .eq('key', parsed.data.key);
  if (error) {
    return NextResponse.json(
      { error: error.message ?? 'not allowed (owner/admin only)' },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: params.id,
    user_id: user.id,
    action: 'org.secret.unset',
    resource_type: 'org_secret',
    resource_id: parsed.data.key,
  });

  return NextResponse.json({ ok: true });
}
