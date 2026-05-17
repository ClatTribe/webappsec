import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyGitHubSignature } from '@/lib/github';

// Tier II #7 — GitHub webhook receiver.
//
// POST /api/webhooks/github
//
// Listens for `pull_request` events and creates a diff-mode scan
// for the PR. The scan's PR context columns (github_owner /
// github_repo / github_pull_request_number / github_head_sha)
// are populated at insert time so the worker's post-finalize hook
// has everything it needs to POST the sticky comment.
//
// Per-integration setup:
//   1. User connects GitHub via OAuth → integration row created
//      with type='github'.
//   2. User goes to Settings → Integrations → "Enable PR scanning"
//      which:
//         a. generates a random webhook secret + stores it on
//            integrations.metadata.webhook_secret
//         b. registers a repo webhook pointing at this route with
//            the secret
//         c. stamps integrations.metadata.repo_full_name so we can
//            route incoming deliveries.
//   (The UI for step 2 is a follow-up — for now the integration
//    can be wired by hand for the marquee dogfood demo.)
//
// We respond 202 fast and let the worker pipeline pick up the scan
// — GitHub disables webhooks that 5xx repeatedly, so synchronous
// scan-create with a hard fail is unacceptable.

const HANDLED_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

interface IntegrationMetadata {
  login?: string;
  repo_full_name?: string;
  webhook_secret?: string;
  default_branch?: string;
  [k: string]: unknown;
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    html_url: string;
    state: string;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    draft?: boolean;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
    default_branch: string;
    html_url: string;
  };
}

export async function POST(req: Request) {
  const event = req.headers.get('x-github-event') ?? '';
  const deliveryId = req.headers.get('x-github-delivery') ?? '';
  const signature = req.headers.get('x-hub-signature-256');

  // Body must be read as text *first* so the HMAC verifies on the
  // exact bytes GitHub signed. Parsing JSON then re-stringifying
  // would re-order keys + drop whitespace and corrupt the signature.
  const rawBody = await req.text();

  // ---- 0. Ignore non-PR events fast (still 200 so GitHub doesn't
  //         flag the webhook unhealthy). --------------------------
  if (event === 'ping') {
    return NextResponse.json({ ok: true, ack: 'ping' });
  }
  if (event !== 'pull_request') {
    return NextResponse.json({ ok: true, ignored: `event=${event}` }, { status: 202 });
  }

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(rawBody) as PullRequestEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!HANDLED_ACTIONS.has(payload.action)) {
    return NextResponse.json(
      { ok: true, ignored: `action=${payload.action}` },
      { status: 202 },
    );
  }
  if (payload.pull_request?.draft) {
    return NextResponse.json({ ok: true, ignored: 'draft PR' }, { status: 202 });
  }

  // ---- 1. Find the matching integration by repo full_name --------
  // We use the admin client because webhook deliveries arrive
  // unauthenticated — RLS would block all reads.
  const admin = createAdminClient();
  const repoFullName = payload.repository.full_name;

  // Supabase generated types treat admin-client reads as `never`,
  // so we cast through unknown to the wrapper-internal row shape.
  // This is the same pattern used in the apply-patch route + Phase B
  // regression query.
  interface IntegrationRow {
    id: string;
    org_id: string;
    type: string;
    status: string;
    metadata: IntegrationMetadata | null;
  }

  const { data: candidateInts } = (await admin
    .from('integrations')
    .select('id, org_id, type, status, metadata')
    .eq('type', 'github')
    .eq('status', 'active')) as unknown as { data: IntegrationRow[] | null };

  const integration = (candidateInts ?? []).find((row) => {
    const meta = (row.metadata ?? {}) as IntegrationMetadata;
    return meta.repo_full_name === repoFullName;
  });

  if (!integration) {
    // 404 is the right code — GitHub will surface this in the webhook
    // logs so the user can debug why their delivery isn't routing.
    return NextResponse.json(
      { error: `no_matching_integration for ${repoFullName}` },
      { status: 404 },
    );
  }

  // ---- 2. Signature verification (per-integration HMAC key) ------
  const meta = (integration.metadata ?? {}) as IntegrationMetadata;
  const webhookSecret = meta.webhook_secret;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: 'integration has no webhook_secret configured' },
      { status: 412 },
    );
  }
  const verified = await verifyGitHubSignature(rawBody, signature, webhookSecret);
  if (!verified) {
    return NextResponse.json({ error: 'signature mismatch' }, { status: 401 });
  }

  // ---- 3. Find the matching target row for this repo (or create
  //         it). Diff-mode scans need a target row to attach to;
  //         we don't auto-create one if the org hasn't registered
  //         this repo as a target (avoids surprise charges).
  const repoUrl = payload.repository.html_url;
  const { data: target } = (await admin
    .from('targets')
    .select('id, type, value')
    .eq('org_id', integration.org_id)
    .eq('type', 'repository')
    .eq('value', repoUrl)
    .maybeSingle()) as unknown as { data: { id: string; type: string; value: string } | null };

  if (!target) {
    return NextResponse.json(
      {
        error: 'no_matching_target',
        hint: `Add ${repoUrl} as a repository target in TensorShield before enabling PR scanning.`,
      },
      { status: 412 },
    );
  }

  // ---- 4. Insert the scan with PR context ------------------------
  // We bypass create_scan_with_targets() because:
  //   (a) it uses auth.uid() which is null in this context
  //   (b) it doesn't know about the PR context columns from 066
  // Direct admin INSERT is safe because the integration check
  // above proved the caller (GitHub) has a signed delivery for an
  // org-owned integration on an org-owned repo.

  const runName = `PR #${payload.pull_request.number}: ${truncate(
    repoFullName,
    80,
  )} @ ${payload.pull_request.head.sha.slice(0, 7)}`;

  const { data: created, error: insertErr } = (await admin
    .from('scans')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({
      org_id: integration.org_id,
      // Webhook deliveries have no user — stamp the integration owner
      // as the scan owner so the audit trail isn't blank.
      user_id: (await resolveIntegrationOwner(admin, integration.id)) ?? integration.org_id,
      target_id: target.id,
      run_name: runName,
      status: 'queued',
      scan_mode: 'quick', // PR scans are inherently scoped — quick is the right default
      scope_mode: 'diff',
      diff_base: payload.pull_request.base.ref,
      branch: payload.pull_request.head.ref,
      github_owner: payload.repository.owner.login,
      github_repo: payload.repository.name,
      github_pull_request_number: payload.pull_request.number,
      github_head_sha: payload.pull_request.head.sha,
    } as any)
    .select('id')
    .single()) as unknown as { data: { id: string } | null; error: { message: string } | null };

  if (insertErr || !created) {
    return NextResponse.json(
      { error: `failed to create scan: ${insertErr?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  // Stamp a corresponding scan_targets row so the worker picks up
  // the target alongside the scan (mirrors create_scan_with_targets).
  await admin
    .from('scan_targets')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({
      scan_id: created.id,
      type: 'repository',
      value: repoUrl,
      workspace_subdir: null,
      source_integration_id: integration.id,
    } as any);

  // Link the integration so worker_decrypt_integration() permits
  // the worker (and the post-finalize PR comment route) to fetch
  // the OAuth token.
  await admin
    .from('scan_integrations')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({ scan_id: created.id, integration_id: integration.id } as any);

  return NextResponse.json(
    {
      ok: true,
      scan_id: created.id,
      delivery_id: deliveryId,
      action: payload.action,
      pr: payload.pull_request.number,
    },
    { status: 202 },
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Look up the user_id who originally connected this integration. Used
// as the scan's user_id stamp so the audit log isn't blank for webhook
// -driven scans (`integrations.created_by` is the OAuth flow user).
async function resolveIntegrationOwner(
  admin: ReturnType<typeof createAdminClient>,
  integrationId: string,
): Promise<string | null> {
  const { data } = (await admin
    .from('integrations')
    .select('created_by')
    .eq('id', integrationId)
    .maybeSingle()) as unknown as { data: { created_by?: string } | null };
  return data?.created_by ?? null;
}
