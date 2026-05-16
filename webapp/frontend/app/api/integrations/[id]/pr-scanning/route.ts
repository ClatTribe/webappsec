import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { randomBytes } from 'crypto';

// Tier II #7 — enable / disable PR scanning for a single repo on a
// GitHub integration.
//
//   POST    /api/integrations/[id]/pr-scanning
//     body:   { repo_full_name: "owner/repo" }
//     action: mint a new HMAC webhook secret (or reuse if present),
//             stamp integrations.metadata.{webhook_secret,repo_full_name},
//             return the webhook URL + secret + 4-step setup checklist
//             so the user can paste them into github.com/<repo>/settings/hooks.
//
//   GET     /api/integrations/[id]/pr-scanning
//     action: return current state — useful for the management UI to
//             know "is PR scanning already enabled?"
//
//   DELETE  /api/integrations/[id]/pr-scanning
//     action: clear webhook_secret + repo_full_name. The user is
//             responsible for removing the webhook on github.com's
//             side; we just stop accepting deliveries (signature
//             mismatch will reject).
//
// All three are user-context routes (RLS-gated on integrations).
// The metadata edits happen via the admin client because RLS on
// `integrations.metadata` permits update only when the row already
// matches current_org_id() — that's enforced by the SELECT-gated
// fetch above before any write.

interface IntegrationMetadata {
  webhook_secret?: string;
  repo_full_name?: string;
  [k: string]: unknown;
}

function mintWebhookSecret(): string {
  // 32 random bytes → 256 bits of entropy. Base64 because GitHub's
  // webhook UI accepts arbitrary printable strings; base64 is the
  // common idiom and is shorter than hex.
  return randomBytes(32).toString('base64');
}

function webhookUrl(): string {
  // Same env fallback as lib/seo.ts so the value matches the
  // canonical site URL used elsewhere in the app.
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
    'https://tensorshield.ai';
  return `${base.replace(/\/$/, '')}/api/webhooks/github`;
}

async function loadIntegration(integrationId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'unauthenticated' as const, status: 401 };

  // RLS scopes to current_org_id — successful select proves ownership.
  const { data, error } = await supabase
    .from('integrations')
    .select('id, org_id, type, status, metadata')
    .eq('id', integrationId)
    .single();
  if (error || !data) {
    return { error: 'integration not found or no access' as const, status: 404 };
  }
  if (data.type !== 'github') {
    return { error: 'PR scanning only supported on github integrations' as const, status: 400 };
  }
  return { integration: data };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const loaded = await loadIntegration(params.id);
  if ('error' in loaded) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }
  const meta = (loaded.integration.metadata ?? {}) as IntegrationMetadata;
  return NextResponse.json({
    enabled: !!(meta.webhook_secret && meta.repo_full_name),
    repo_full_name: meta.repo_full_name ?? null,
    webhook_url: webhookUrl(),
    // We never return the secret on GET — the user must hold it
    // from the original POST response. If they lost it, DELETE + POST
    // to mint a new one (and re-paste on GitHub).
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const loaded = await loadIntegration(params.id);
  if ('error' in loaded) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  const body = await req.json().catch(() => ({}));
  const repoFullName = typeof body?.repo_full_name === 'string' ? body.repo_full_name.trim() : '';
  if (!repoFullName || !/^[^\/\s]+\/[^\/\s]+$/.test(repoFullName)) {
    return NextResponse.json(
      { error: 'repo_full_name required in the form "owner/repo"' },
      { status: 400 },
    );
  }

  const existing = (loaded.integration.metadata ?? {}) as IntegrationMetadata;
  const newSecret = existing.webhook_secret ?? mintWebhookSecret();
  const newMeta: IntegrationMetadata = {
    ...existing,
    webhook_secret: newSecret,
    repo_full_name: repoFullName,
  };

  const admin = createAdminClient();
  const { error } = await admin
    .from('integrations')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ metadata: newMeta } as never)
    .eq('id', loaded.integration.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    webhook_url: webhookUrl(),
    webhook_secret: newSecret, // shown ONCE in the UI; reset to rotate.
    repo_full_name: repoFullName,
    setup_steps: [
      `1. Go to https://github.com/${repoFullName}/settings/hooks/new`,
      `2. Payload URL: ${webhookUrl()}`,
      `3. Content type: application/json`,
      `4. Secret: (paste the webhook_secret above)`,
      `5. Events: select "Pull requests" only`,
      `6. Save. Open a draft PR to test (drafts are ignored, so it won't fire).`,
    ],
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const loaded = await loadIntegration(params.id);
  if ('error' in loaded) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }
  const existing = (loaded.integration.metadata ?? {}) as IntegrationMetadata;
  const cleaned = { ...existing };
  delete cleaned.webhook_secret;
  delete cleaned.repo_full_name;

  const admin = createAdminClient();
  const { error } = await admin
    .from('integrations')
    .update({ metadata: cleaned } as never)
    .eq('id', loaded.integration.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, disabled: true });
}
