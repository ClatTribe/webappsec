// Asset-discovery runner.
//
// Bridges the cron route, the per-integration discoverer modules,
// and the Supabase admin client. Mirrors the evidence-collector
// runner exactly so a future refactor that hoists shared
// integration-decryption code into a single helper is mechanical.

import { createAdminClient } from '@/lib/supabase/admin';
import { discoverersForIntegration } from './registry';
import type {
  DiscovererContext,
  DiscoveredAsset,
  IntegrationType,
} from './types';

interface IntegrationRow {
  id: string;
  org_id: string;
  type: string;
  status: string;
  metadata: Record<string, unknown> | null;
  vault_secret_id: string | null;
}

interface RunOutcome {
  /** Number of discoverers that ran for this integration. */
  discoverers_run: number;
  /** Total assets upserted across all discoverers. */
  assets_upserted: number;
  /** Per-discoverer errors (best-effort: we keep going on partial
   *  failures so a flaky AWS subaccount doesn't kill the whole run). */
  errors: Array<{ discoverer_id: string; error: string }>;
}

/** Run discovery for one integration. Always best-effort: a discoverer
 *  failure does NOT abort the run; it's captured in the outcome.
 *  Called from the cron route per integration. */
export async function runDiscoveryForIntegration(args: {
  integrationId: string;
}): Promise<RunOutcome> {
  const admin = createAdminClient();
  const outcome: RunOutcome = {
    discoverers_run: 0,
    assets_upserted: 0,
    errors: [],
  };

  // --- 1. Resolve the integration --------------------------------
  const { data: intRow } = (await admin
    .from('integrations')
    .select('id, org_id, type, status, metadata, vault_secret_id')
    .eq('id', args.integrationId)
    .maybeSingle()) as unknown as { data: IntegrationRow | null };

  if (!intRow) {
    outcome.errors.push({ discoverer_id: '(integration)', error: 'integration not found' });
    return outcome;
  }
  if (intRow.status !== 'active') {
    outcome.errors.push({
      discoverer_id: '(integration)',
      error: `integration not active (status: ${intRow.status})`,
    });
    return outcome;
  }

  const discoverers = discoverersForIntegration(intRow.type);
  if (discoverers.length === 0) {
    // Not an error — most integrations (webhooks, K8s today) don't
    // ship a discoverer yet. Stamp last_discovery_at so the cron
    // doesn't pick this row again next loop.
    await stampLastDiscoveryAt(args.integrationId);
    return outcome;
  }

  // --- 2. Decrypt the vault payload once ------------------------
  if (!intRow.vault_secret_id) {
    outcome.errors.push({ discoverer_id: '(integration)', error: 'no vault_secret_id' });
    return outcome;
  }
  const { data: vaultRow } = (await (
    admin as unknown as { schema: (s: string) => ReturnType<typeof admin.from> }
  )
    .schema('vault')
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', intRow.vault_secret_id)
    .single()) as unknown as { data: { decrypted_secret: string } | null };

  if (!vaultRow?.decrypted_secret) {
    outcome.errors.push({
      discoverer_id: '(integration)',
      error: 'failed to decrypt integration vault secret',
    });
    return outcome;
  }
  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(vaultRow.decrypted_secret);
  } catch {
    outcome.errors.push({
      discoverer_id: '(integration)',
      error: 'vault secret is not valid JSON',
    });
    return outcome;
  }

  // --- 3. Run each compatible discoverer ------------------------
  for (const d of discoverers) {
    outcome.discoverers_run += 1;
    const ctx: DiscovererContext = {
      orgId: intRow.org_id,
      integrationId: intRow.id,
      integrationType: intRow.type as IntegrationType,
      integrationCreds: creds,
      integrationMetadata: intRow.metadata ?? {},
    };
    try {
      const result = await d.run(ctx);
      const n = await upsertDiscoveredAssets(admin, {
        orgId: intRow.org_id,
        integrationId: intRow.id,
        assets: result.assets,
      });
      outcome.assets_upserted += n;
      if (result.partial_error) {
        outcome.errors.push({ discoverer_id: d.id, error: result.partial_error });
      }
    } catch (e) {
      outcome.errors.push({
        discoverer_id: d.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await stampLastDiscoveryAt(args.integrationId);
  return outcome;
}

/** Upsert one batch of DiscoveredAssets keyed by canonical_id. Re-runs
 *  are idempotent: an asset re-seen on a later run keeps its current
 *  status (so an `imported` asset doesn't flip back to `pending`),
 *  but its `last_seen_at` and `attributes` get refreshed. */
async function upsertDiscoveredAssets(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    orgId: string;
    integrationId: string;
    assets: DiscoveredAsset[];
  },
): Promise<number> {
  if (args.assets.length === 0) return 0;

  // We can't use a single upsert(onConflict) because the desired
  // update behaviour is conditional (don't reset status if already
  // approved/imported). Instead we do a two-pass: find which
  // canonical_ids already exist for this (org, integration), update
  // them, and insert the new ones.

  const canonicalIds = args.assets.map((a) => a.canonical_id);
  const { data: existing } = (await admin
    .from('discovered_assets')
    .select('id, canonical_id, status')
    .eq('org_id', args.orgId)
    .eq('integration_id', args.integrationId)
    .in('canonical_id', canonicalIds)) as unknown as {
    data: Array<{ id: string; canonical_id: string; status: string }> | null;
  };
  const existingByCid = new Map((existing ?? []).map((r) => [r.canonical_id, r]));

  const inserts: Array<{
    org_id: string;
    integration_id: string;
    asset_type: string;
    canonical_id: string;
    display_name: string;
    attributes: Record<string, unknown>;
    suggested_config: Record<string, unknown>;
    confidence: string;
  }> = [];
  const updates: Array<{
    id: string;
    display_name: string;
    attributes: Record<string, unknown>;
    suggested_config: Record<string, unknown>;
    confidence: string;
    last_seen_at: string;
  }> = [];

  const now = new Date().toISOString();
  for (const asset of args.assets) {
    const ex = existingByCid.get(asset.canonical_id);
    if (ex) {
      // Refresh metadata; do NOT touch status. last_seen_at stamps
      // continuous presence for the UI's "active in last 24h" badge.
      updates.push({
        id: ex.id,
        display_name: asset.display_name,
        attributes: asset.attributes,
        suggested_config: asset.suggested_config,
        confidence: asset.confidence,
        last_seen_at: now,
      });
    } else {
      inserts.push({
        org_id: args.orgId,
        integration_id: args.integrationId,
        asset_type: asset.asset_type,
        canonical_id: asset.canonical_id,
        display_name: asset.display_name,
        attributes: asset.attributes,
        suggested_config: asset.suggested_config,
        confidence: asset.confidence,
      });
    }
  }

  if (inserts.length > 0) {
    await admin.from('discovered_assets').insert(inserts as never);
  }
  // Per-row updates — Supabase doesn't support bulk-update of
  // different values across many rows in a single call. The 500-asset
  // cap is well within the round-trip budget; if we ever discover an
  // org with 5k+ assets we can batch via an RPC.
  for (const u of updates) {
    const { id, ...rest } = u;
    await admin
      .from('discovered_assets')
      .update(rest as never)
      .eq('id', id);
  }

  return inserts.length + updates.length;
}

async function stampLastDiscoveryAt(integrationId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('integrations')
    .update({ last_discovery_at: new Date().toISOString() } as never)
    .eq('id', integrationId);
}
