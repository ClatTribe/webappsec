// Continuous evidence collectors — type contract.
//
// A "collector" is a tiny module that polls one operational SaaS
// (GitHub Admin, AWS IAM, Okta, ...) on a schedule and emits compliance
// evidence rows that credit framework controls. Every collector
// follows the same lifecycle:
//
//   1. The cron route picks up the row from `due_collectors()`.
//   2. The runner decrypts the linked integration's vault secret.
//   3. The collector's `run()` reads the SaaS via its API and returns
//      a batch of EvidenceRow[].
//   4. The runner upserts them via the `upsert_collector_evidence`
//      RPC and writes a row to `evidence_collector_runs`.
//
// Each collector is pure: no DB writes, no scan-specific assumptions —
// just `(creds) → evidence`. That keeps unit tests trivial and the
// shared upsert path drift-free.

import type { McpScope } from '@/lib/mcp/auth';

/** Where the wrapper expects the collector's credentials to come from. */
export type IntegrationType = 'github' | 'aws' | 'gcp' | 'azure' | 'k8s' | 'gitlab';

/** A single row destined for compliance_evidence via the
 *  upsert_collector_evidence RPC. Mirrors the table's columns 1:1
 *  except we drop org_id (provided by the runner) and scan_id (always
 *  null for collector-emitted rows). */
export interface EvidenceRow {
  framework: string;
  control_id: string;
  verdict: 'pass' | 'fail' | 'warn' | 'info' | 'untested';
  /** Free-form JSON the auditor pack reads verbatim. Convention:
   *    {
   *      expires_at?: string  // ISO. When omitted, defaults to
   *                           // now() + 30 days at runner time so
   *                           // PR #252's freshness math works.
   *      observed_state?: any // raw signal from the upstream API
   *      doc_links?: string[] // shopping-list of links to the
   *                           // upstream UI for auditor verification
   *    }
   */
  detail: Record<string, unknown>;
  /** Single-line human summary shown next to the verdict in the UI.
   *  Keep under 200 chars — the trust-page projection truncates. */
  evidence_summary: string;
}

/** Live context handed to a collector's `run()` method. */
export interface CollectorContext {
  orgId: string;
  integrationId: string;
  integrationType: IntegrationType;
  /** Decrypted vault payload — collector-specific shape. */
  integrationCreds: Record<string, unknown>;
  /** integrations.metadata — already-decrypted, safe to log. */
  integrationMetadata: Record<string, unknown>;
}

/** What the collector returns when its run completes. */
export interface CollectorResult {
  rows: EvidenceRow[];
  /** When a collector partially failed (e.g., one of 3 framework
   *  controls couldn't be checked due to a missing scope), it can
   *  return rows + a partial-error summary. The runner writes this
   *  to evidence_collector_runs.error_message and flips status to
   *  'partial' rather than 'error'. */
  partial_error?: string;
}

/** Static metadata + the implementation for a single collector. */
export interface CollectorDefinition {
  id: string;
  provider: string;
  display_name: string;
  /** One-paragraph user-facing description shown on the
   *  /compliance/collectors page. */
  description: string;
  /** Which integration type this collector's creds come from. The
   *  runner validates this at run time so a wrong wiring fails loudly. */
  integration_type: IntegrationType;
  /** Required scopes if the integration is an OAuth-based one (GitHub).
   *  Currently informational; we don't enforce client-side. */
  required_scopes?: McpScope[];
  /** How many controls this collector can credit at peak. Used for
   *  the "credits up to N controls" callout. */
  controls_emitted: number;
  /** Mode of operation — affects the UI badge. 'read_only' (boto3 /
   *  GitHub Admin read API) vs 'mutating' (none today; reserved). */
  mode: 'read_only';
  /** Default frequency for new enablements. Min 5 / max 10080 per
   *  the migration's CHECK. */
  default_frequency_minutes: number;
  /** Pure function: (creds) → (evidence). No DB, no fetch outside the
   *  upstream API. Tests stub the HTTP layer. */
  run(ctx: CollectorContext): Promise<CollectorResult>;
}
