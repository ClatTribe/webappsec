import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyGitHubSignature } from '@/lib/github';

// Phase E — GitHub App webhook receiver for asset-discovery events.
//
// POST /api/webhooks/github-app
//
// Separate from /api/webhooks/github (Tier II #7, the per-integration
// OAuth-based PR webhook) because the auth model is different:
//
//   /api/webhooks/github       : per-repo, signed with the
//                                integration's own webhook_secret,
//                                routes to a specific repository
//                                target row.
//   /api/webhooks/github-app   : org-level, signed with the app-wide
//                                GITHUB_APP_WEBHOOK_SECRET env, routes
//                                to discovered_assets so Phase A's
//                                approval flow picks the new repos up.
//
// Handled events (all from the App's "installation_repositories" +
// "repository" subscriptions):
//
//   installation_repositories.added   → upsert one discovered_asset
//                                       per repo in repositories_added
//   installation_repositories.removed → mark each repo's
//                                       discovered_asset as 'superseded'
//                                       (Phase F's sweep flips any
//                                       imported target dormant on its
//                                       next run)
//   repository.created (org-wide)     → upsert one discovered_asset
//   repository.deleted                → mark as 'superseded'
//   installation.deleted              → mark all of that install's
//                                       assets as 'superseded'
//
// Signature verification is identical to the OAuth path — same
// SHA-256 HMAC against the raw bytes — only the secret source differs.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AppRepo {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  // The App's installation_repositories payload doesn't include
  // pushed_at / size; we accept what we get and let the regular
  // discovery cron fill in the missing metadata on its next run.
}

interface InstallationRepositoriesEvent {
  action: 'added' | 'removed';
  installation: { id: number; account: { login: string; type: string } };
  repositories_added?: AppRepo[];
  repositories_removed?: AppRepo[];
}

interface RepositoryEvent {
  action: 'created' | 'deleted' | 'archived' | 'unarchived' | 'edited';
  installation?: { id: number };
  repository: AppRepo & { html_url: string };
}

interface InstallationDeletedEvent {
  action: 'deleted' | 'suspend' | 'unsuspend';
  installation: { id: number };
  repositories?: AppRepo[];
}

interface IntegrationRow {
  id: string;
  org_id: string;
  metadata: { github_app_installation_id?: string | number } | null;
}

export async function POST(req: Request) {
  const event = req.headers.get('x-github-event') ?? '';
  const signature = req.headers.get('x-hub-signature-256');
  const deliveryId = req.headers.get('x-github-delivery') ?? '';
  const rawBody = await req.text();

  if (event === 'ping') {
    return NextResponse.json({ ok: true, ack: 'ping' });
  }

  const appSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!appSecret) {
    return NextResponse.json(
      {
        error:
          'GITHUB_APP_WEBHOOK_SECRET is not configured on the server. Asset-discovery webhooks are disabled.',
      },
      { status: 412 },
    );
  }
  if (!(await verifyGitHubSignature(rawBody, signature, appSecret))) {
    return NextResponse.json({ error: 'signature mismatch' }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Resolve the installation_id → integration → org. We do this once
  // up front so the per-event handlers below stay focused.
  const installationId = (() => {
    const p = parsed as
      | InstallationRepositoriesEvent
      | RepositoryEvent
      | InstallationDeletedEvent
      | { installation?: { id?: number } };
    return p.installation?.id ?? null;
  })();

  if (installationId === null) {
    return NextResponse.json(
      { error: 'no installation id in payload — App webhook expected' },
      { status: 400 },
    );
  }

  // Match by integration metadata. We store the install id as a string
  // (JSONB → numeric jsonb coercion was inconsistent) so compare both.
  const { data: candidates } = (await admin
    .from('integrations')
    .select('id, org_id, metadata')
    .eq('type', 'github')
    .eq('status', 'active')) as unknown as { data: IntegrationRow[] | null };

  const integration = (candidates ?? []).find((i) => {
    const meta = i.metadata ?? {};
    const stored = meta.github_app_installation_id;
    return (
      stored !== undefined &&
      String(stored) === String(installationId)
    );
  });

  if (!integration) {
    // Most common cause: user installed the App but hasn't connected
    // it to a wrapper org yet (or revoked the integration). 202 keeps
    // GitHub from disabling the webhook.
    return NextResponse.json(
      {
        ok: true,
        ignored: 'no_matching_integration_for_install',
        installation_id: installationId,
      },
      { status: 202 },
    );
  }

  // ---- per-event handlers ----------------------------------------
  let outcome: { added: number; superseded: number };
  if (event === 'installation_repositories') {
    outcome = await handleInstallationRepositories(
      admin,
      integration,
      parsed as InstallationRepositoriesEvent,
    );
  } else if (event === 'repository') {
    outcome = await handleRepository(
      admin,
      integration,
      parsed as RepositoryEvent,
    );
  } else if (event === 'installation') {
    outcome = await handleInstallation(
      admin,
      integration,
      parsed as InstallationDeletedEvent,
    );
  } else {
    return NextResponse.json(
      { ok: true, ignored: `event=${event}` },
      { status: 202 },
    );
  }

  // One audit_log row per delivery so the org can see what we did
  // without parsing the per-asset rows.
  await admin.from('audit_log').insert({
    org_id: integration.org_id,
    user_id: null,
    action: 'github_app.webhook_delivered',
    resource_type: 'integration',
    resource_id: integration.id,
    metadata: {
      event,
      delivery_id: deliveryId,
      installation_id: installationId,
      added: outcome.added,
      superseded: outcome.superseded,
    },
  } as never);

  return NextResponse.json({
    ok: true,
    event,
    added: outcome.added,
    superseded: outcome.superseded,
  });
}

async function handleInstallationRepositories(
  admin: ReturnType<typeof createAdminClient>,
  integration: IntegrationRow,
  payload: InstallationRepositoriesEvent,
): Promise<{ added: number; superseded: number }> {
  let added = 0;
  let superseded = 0;

  if (payload.action === 'added' && payload.repositories_added) {
    added = await upsertDiscoveredRepos(admin, integration, payload.repositories_added);
  } else if (payload.action === 'removed' && payload.repositories_removed) {
    superseded = await markRemovedRepos(
      admin,
      integration,
      payload.repositories_removed,
    );
  }
  return { added, superseded };
}

async function handleRepository(
  admin: ReturnType<typeof createAdminClient>,
  integration: IntegrationRow,
  payload: RepositoryEvent,
): Promise<{ added: number; superseded: number }> {
  if (payload.action === 'created') {
    const n = await upsertDiscoveredRepos(admin, integration, [payload.repository]);
    return { added: n, superseded: 0 };
  }
  if (payload.action === 'deleted' || payload.action === 'archived') {
    const n = await markRemovedRepos(admin, integration, [payload.repository]);
    return { added: 0, superseded: n };
  }
  // unarchived / edited — no-op; the regular discovery cron picks up
  // attribute changes on its next run.
  return { added: 0, superseded: 0 };
}

async function handleInstallation(
  admin: ReturnType<typeof createAdminClient>,
  integration: IntegrationRow,
  payload: InstallationDeletedEvent,
): Promise<{ added: number; superseded: number }> {
  if (payload.action === 'deleted' || payload.action === 'suspend') {
    // Supersede every discovered_asset that belongs to this
    // integration. Phase F's sweep will flip the materialised targets
    // dormant on its next run via the integration_removed heuristic.
    const { data: rows } = (await admin
      .from('discovered_assets')
      .update({ status: 'superseded' } as never)
      .eq('integration_id', integration.id)
      .eq('status', 'pending')
      .select('id')) as unknown as { data: Array<{ id: string }> | null };
    return { added: 0, superseded: rows?.length ?? 0 };
  }
  return { added: 0, superseded: 0 };
}

async function upsertDiscoveredRepos(
  admin: ReturnType<typeof createAdminClient>,
  integration: IntegrationRow,
  repos: AppRepo[],
): Promise<number> {
  if (repos.length === 0) return 0;

  // Filter to the canonical_ids that don't already exist as approved /
  // imported / rejected — re-surfacing those would be noise.
  const canonicalIds = repos.map((r) => `github:${r.full_name}`);
  const { data: existing } = (await admin
    .from('discovered_assets')
    .select('canonical_id, status')
    .eq('integration_id', integration.id)
    .in('canonical_id', canonicalIds)) as unknown as {
    data: Array<{ canonical_id: string; status: string }> | null;
  };
  const knownStatusByCid = new Map(
    (existing ?? []).map((r) => [r.canonical_id, r.status]),
  );

  const inserts = repos
    .filter((r) => {
      const known = knownStatusByCid.get(`github:${r.full_name}`);
      // pending → already proposed; imported/rejected → user decided.
      // superseded → previous removal; we re-pend on re-add.
      return known === undefined || known === 'superseded';
    })
    .map((r) => ({
      org_id: integration.org_id,
      integration_id: integration.id,
      asset_type: 'repository',
      canonical_id: `github:${r.full_name}`,
      display_name: r.full_name,
      attributes: {
        value: `https://github.com/${r.full_name}`,
        upstream_url: `https://github.com/${r.full_name}`,
        tags: [r.private ? 'private' : 'public'],
        integration_id: integration.id,
        // The App webhook payload is leaner than /user/repos so we
        // don't have age_days here — the regular discovery cron will
        // fill that in within 24h.
      },
      suggested_config: {
        scan_mode: 'standard',
        scan_frequency: 'weekly',
        integration_id: integration.id,
      },
      confidence: 'medium' as const,
      status: 'pending' as const,
    }));

  if (inserts.length === 0) return 0;

  // For canonical_ids that exist as 'superseded' we need to re-pend
  // them; the table's unique (org_id, integration_id, canonical_id)
  // means a plain insert collides. Two-pass:
  //   (a) update existing superseded → pending
  //   (b) insert brand-new
  const supersededCids = (existing ?? [])
    .filter((r) => r.status === 'superseded')
    .map((r) => r.canonical_id);

  if (supersededCids.length > 0) {
    await admin
      .from('discovered_assets')
      .update({ status: 'pending', last_seen_at: new Date().toISOString() } as never)
      .eq('integration_id', integration.id)
      .in('canonical_id', supersededCids);
  }

  const trulyNew = inserts.filter((i) => !supersededCids.includes(i.canonical_id));
  if (trulyNew.length > 0) {
    await admin.from('discovered_assets').insert(trulyNew as never);
  }

  return inserts.length;
}

async function markRemovedRepos(
  admin: ReturnType<typeof createAdminClient>,
  integration: IntegrationRow,
  repos: AppRepo[],
): Promise<number> {
  if (repos.length === 0) return 0;
  const canonicalIds = repos.map((r) => `github:${r.full_name}`);
  const { data } = (await admin
    .from('discovered_assets')
    .update({ status: 'superseded' } as never)
    .eq('integration_id', integration.id)
    .in('canonical_id', canonicalIds)
    .in('status', ['pending'])
    .select('id')) as unknown as { data: Array<{ id: string }> | null };
  return data?.length ?? 0;
}
