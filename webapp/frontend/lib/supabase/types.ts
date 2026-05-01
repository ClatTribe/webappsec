// Hand-written types matching the Supabase schema.
// In production you'd generate these via `supabase gen types typescript --linked > types.ts`.

export type IntegrationType = 'github' | 'gitlab' | 'aws' | 'azure' | 'gcp' | 'k8s' | 'webhook';
export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ScanMode = 'quick' | 'standard' | 'deep';
export type ScopeMode = 'auto' | 'diff' | 'full';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'triaged_real' | 'false_positive' | 'wont_fix' | 'fixed';
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type TargetType = 'local_code' | 'repository' | 'web_application' | 'domain' | 'ip_address';
export type ScanFrequency = 'manual' | 'daily' | 'weekly' | 'monthly';
export type TargetStatus = 'active' | 'archived';

export interface Target {
  id: string;
  org_id: string;
  name: string;
  type: TargetType;
  value: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  last_scan_at: string | null;
  scan_frequency: ScanFrequency;
  status: TargetStatus;
  auto_discover: boolean;
  config: Record<string, unknown>;
}

export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'pro' | 'enterprise';
  llm_provider: string | null;
  created_at: string;
}

export interface OrgMember {
  user_id: string;
  org_id: string;
  role: OrgRole;
  created_at: string;
}

export interface Integration {
  id: string;
  org_id: string;
  type: IntegrationType;
  name: string;
  metadata: Record<string, unknown>;
  status: 'active' | 'revoked' | 'expired';
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

export interface Scan {
  id: string;
  org_id: string;
  target_id: string | null;
  user_id: string;
  run_name: string;
  status: ScanStatus;
  scan_mode: ScanMode;
  scope_mode: ScopeMode | null;
  diff_base: string | null;
  instruction_text: string | null;
  llm_provider: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  agents_count: number;
  exit_code: number | null;
  artifact_prefix: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat_at: string | null;
  cancel_requested_at: string | null;
}

export interface ScanTarget {
  id: string;
  scan_id: string;
  type: 'local_code' | 'repository' | 'web_application' | 'domain' | 'ip_address';
  value: string;
  workspace_subdir: string | null;
  source_integration_id: string | null;
}

export interface ScanEvent {
  id: number;
  scan_id: string;
  org_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface Finding {
  id: string;
  scan_id: string;
  org_id: string;
  vuln_id: string;
  title: string;
  severity: Severity;
  cvss: number | null;
  cvss_vector: string | null;
  cwe: string | null;
  cve: string | null;
  target: string | null;
  endpoint: string | null;
  method: string | null;
  description_md: string | null;
  technical_analysis_md: string | null;
  poc_md: string | null;
  impact_md: string | null;
  remediation_md: string | null;
  affected_files: unknown;
  status: FindingStatus;
  triaged_by: string | null;
  triaged_at: string | null;
  triage_notes: string | null;
  fingerprint: string | null;
  created_at: string;
  // Cross-scan dedup fields. The `findings` row is a *summary*; the per-scan
  // history lives in `finding_occurrences`. The columns below are
  // denormalised conveniences populated by `worker_insert_finding`.
  times_seen?: number | null;
  /** Bookend pair around the finding's lifespan. */
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  last_seen_scan_id?: string | null;
  /** Number of times a 'fixed' status was flipped back by recurrence. */
  reopened_count?: number | null;
  ai_assessment?: AiAssessment | null;
  ai_assessed_at?: string | null;
}

/**
 * Per-(finding, scan) ledger row. The unique `(finding_id, scan_id)` key
 * means at most one entry exists per scan even if the worker retries within
 * a single run. `reopened` is set on the occurrence that flipped a 'fixed'
 * finding back to 'triaged_real'.
 */
export interface FindingOccurrence {
  id: string;
  finding_id: string;
  scan_id: string;
  org_id: string;
  seen_at: string;
  reopened: boolean;
}

/**
 * One labeled training pair — a user's triage decision on a finding.
 * Captured by a Postgres trigger on every status change made by an
 * authenticated user (worker auto-flips don't produce signals; see
 * migration 018). Per-org RLS; the loop never trains across tenants.
 */
export interface TriageSignal {
  id: string;
  finding_id: string;
  org_id: string;
  decided_by: string | null;       // null on backfill rows; users always have it
  decided_at: string;
  prior_status: FindingStatus;
  decision: FindingStatus;
  triage_notes: string | null;
  ai_prediction: AiAssessment | null;  // snapshot at decision time
  finding_features: Record<string, unknown> | null;
}

/**
 * Aggregated breakdown of how this org has triaged "similar" findings
 * before. Returned by the `triage_history_for_finding` RPC. Phase 1
 * defines similar as same CWE + same target. Returns null when no
 * neighbours exist. Used by the "Your team's pattern" UI for its
 * interpretability — exact-match counts the user can audit.
 */
export interface TriageHistory {
  total: number;
  fixed: number;
  triaged_real: number;
  false_positive: number;
  wont_fix: number;
}

/**
 * Per-org KNN inference output for a single finding. Returned by the
 * `predict_triage_for_finding` RPC. Vector-similarity over the org's
 * embedded triage_signals. Returns null when the finding has no
 * embedding (worker hadn't run yet) or the org has no labelled signals
 * (cold start). Used by the Phase 3 confidence-display + auto-dismiss
 * UIs; not for the deterministic "team pattern" display.
 */
export interface TriagePrediction {
  n_neighbours: number;
  mean_similarity: number;
  p_false_positive: number;
  p_real: number;
}

export type AiUrgency = 'fix_now' | 'fix_soon' | 'monitor' | 'dismiss';
export type AiReachability =
  | 'external_unauthenticated'
  | 'external_authenticated'
  | 'internal_only'
  | 'unreachable';

export interface AiAssessment {
  urgency: AiUrgency;
  reachability: AiReachability;
  confidence: number;
  is_likely_false_positive: boolean;
  reasoning: string;
  recommended_action: string;
  model?: string;
}
