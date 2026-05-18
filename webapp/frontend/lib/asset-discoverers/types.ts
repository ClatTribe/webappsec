// Asset discovery — type contract.
//
// A "discoverer" is a tiny module that enumerates scannable resources
// from one connected SaaS / cloud account and proposes them as
// pending targets. The shape mirrors `lib/evidence-collectors/`
// deliberately so the framework feels familiar:
//
//   1. The cron route picks up due integrations from
//      `due_discoveries()` (read: integrations.last_discovery_at is
//      NULL or older than 24h).
//   2. The runner decrypts the integration's vault secret.
//   3. The discoverer's `run()` reads the upstream API and returns
//      a batch of DiscoveredAsset[].
//   4. The runner upserts them via the wrapper-side
//      `upsertDiscoveredAssets()` helper (idempotent on canonical_id).
//
// Each discoverer is pure: no DB writes, no scan-specific assumptions
// — just `(integrationCreds) → assets`. That keeps the unit-test
// surface trivial and the shared upsert/lifecycle code drift-free.

export type AssetType =
  | 'local_code'
  | 'repository'
  | 'web_application'
  | 'domain'
  | 'ip_address'
  | 'api'
  | 'container_image'
  | 'cloud_account';

/** Where the discoverer expects to find its credentials. The
 *  `domain` value (migration 081) is a wrapper-side abstraction —
 *  no real credential, just an apex domain in the vault payload. */
export type IntegrationType =
  | 'github'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'k8s'
  | 'gitlab'
  | 'domain'
  | 'okta';

/** A single proposed target row destined for `discovered_assets`. The
 *  shape mirrors the table 1:1 minus org_id/integration_id (provided
 *  by the runner) and the status/lifecycle columns (managed by the
 *  approval flow). */
export interface DiscoveredAsset {
  /** Mirrors targets.type so import is a straight copy. */
  asset_type: AssetType;
  /** Stable dedup key. Convention: `<provider>:<id>` — e.g.
   *  `github:acme/payments-api`, `aws:123456789012/elbv2/payments-alb`.
   *  Unique per (integration, org); the upsert path uses this. */
  canonical_id: string;
  /** Display name shown in the UI. Should be auditor-readable;
   *  prefer the upstream's own naming (repo full_name, ALB name)
   *  over canonical_id. */
  display_name: string;
  /** Raw discovery metadata. Surfaced under "details" in the UI.
   *  Convention keys (none required):
   *    - value: the canonical target identifier — repo URL,
   *             hostname, image:tag. The approve RPC copies this
   *             into targets.value verbatim.
   *    - description: short auditor-readable description.
   *    - upstream_url: where this resource lives in its console.
   *    - tags: array of strings (auto-tags from upstream naming).
   *    - last_active: ISO timestamp from the upstream (last push,
   *                   last deploy, etc) — helps the UI surface
   *                   "dormant" candidates separately. */
  attributes: Record<string, unknown>;
  /** What scan config the discoverer recommends. Becomes the seed
   *  config when the asset is approved. Customer can override before
   *  import. Free-shape; common keys: scan_mode, scan_frequency,
   *  rate_limit_qps, exclude_paths, seed_urls. */
  suggested_config: Record<string, unknown>;
  /** Hint to the UI on how aggressively to surface this asset.
   *  - high   : we're confident this is something the customer wants
   *             monitored (public ALB on a live AWS account).
   *  - medium : default — prompt for review.
   *  - low    : noise candidate (archived repo, dormant Lambda) —
   *             collapsed by default in the listing. */
  confidence: 'high' | 'medium' | 'low';
}

/** Live context handed to a discoverer's `run()`. Same shape as the
 *  evidence-collector context for cross-pollination. */
export interface DiscovererContext {
  orgId: string;
  integrationId: string;
  integrationType: IntegrationType;
  /** Decrypted vault payload — integration-specific shape. */
  integrationCreds: Record<string, unknown>;
  /** integrations.metadata — non-sensitive, safe to log. */
  integrationMetadata: Record<string, unknown>;
}

/** What the discoverer returns when its run completes. */
export interface DiscovererResult {
  assets: DiscoveredAsset[];
  /** When discovery partially failed (e.g. one of 3 paginated calls
   *  hit a 5xx), we still ingest the assets we got and stamp this
   *  on the run row. Mirrors evidence-collector partial_error. */
  partial_error?: string;
}

/** Static metadata + implementation for a single discoverer. */
export interface DiscovererDefinition {
  /** Stable string id — convention `<provider>_<noun>`. */
  id: string;
  provider: string;
  display_name: string;
  description: string;
  /** Which integration type this discoverer consumes. The runner
   *  validates this against the integration row at run time. */
  integration_type: IntegrationType;
  /** What target types this discoverer can produce — surfaced in
   *  the UI catalog so customers know "GCP IAM doesn't enumerate
   *  domains". */
  produces: AssetType[];
  /** Default frequency for the cron, in minutes. The cron honours
   *  this when picking up the integration's next discovery slot;
   *  customer can override per-integration in v2. */
  default_frequency_minutes: number;
  /** Pure function: (creds) → (assets). No DB, no scan-specific
   *  assumptions. Tests stub the HTTP layer. */
  run(ctx: DiscovererContext): Promise<DiscovererResult>;
}
