import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// PUT/DELETE /api/orgs/[id]/slack-webhook — manage the org's Slack webhook URL.
//
// Tier A — async push notifications. Migration 037 adds
// `organizations.slack_webhook_secret_id` (vault pointer) and the
// `worker_decrypt_org_slack_webhook(p_scan_id)` RPC; this route is
// the user-facing knob.
//
// We re-validate the URL shape both client-side (zod) AND server-side
// in the SQL RPC (regex on `^https://hooks\.slack\.com/services/`) so
// a future API drift can't smuggle an arbitrary outbound webhook into
// the worker's notifier.

const PutBody = z.object({
  // Slack webhook URLs: https://hooks.slack.com/services/<TXX>/<BXX>/<XXXX>
  // Length cap mirrors the LLM-key route's 2 KiB ceiling.
  url: z
    .string()
    .url()
    .startsWith('https://hooks.slack.com/services/')
    .max(2048),
});

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
    p_secret: parsed.data.url,
    p_name: `org_${params.id}_slack_webhook_${Date.now()}`,
    p_description: 'Per-org Slack webhook URL',
  });
  if (secretErr || !secretId) {
    return NextResponse.json(
      { error: secretErr?.message ?? 'vault create failed' },
      { status: 500 },
    );
  }

  const { data, error } = await supabase
    .from('organizations')
    .update({ slack_webhook_secret_id: secretId })
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
    action: 'org.slack_webhook.set',
    resource_type: 'organization',
    resource_id: params.id,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data, error } = await supabase
    .from('organizations')
    .update({ slack_webhook_secret_id: null })
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
    action: 'org.slack_webhook.unset',
    resource_type: 'organization',
    resource_id: params.id,
  });

  return NextResponse.json({ ok: true });
}
