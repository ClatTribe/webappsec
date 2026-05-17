// Hand-written types matching the Supabase schema.
// In production you'd generate these via `supabase gen types typescript --linked > types.ts`.

export type IntegrationType = 'github' | 'gitlab' | 'aws' | 'azure' | 'gcp' | 'k8s' | 'webhook';
export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ScanMode = 'quick' | 'standard' | 'deep';
export type ScopeMode = 'auto' | 'diff' | 'full';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus =
  | 'open'
  | 'triaged_real'
  | 'false_positive'
  | 'wont_fix'
  | 'fixed'
  // Set by the worker's auto-dismiss path when the per-org KNN model is
  // very confident this is a false positive AND the same fingerprint has
  // been dismissed by the org before. Distinct from `false_positive` (user
  // policy) so it's auditable and one-click-reversible. See migration 020.
  | 'dismissed_by_ai';
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type TargetType = 'local_code' | 'repository' | 'web_application' | 'api' | 'container_image' | 'cloud_account' | 'domain' | 'ip_address';
export type ScanFrequency = 'manual' | 'daily' | 'weekly' | 'monthly';
export type TargetStatus = 'active' | 'archived';

export interface TargetSchedule {
  kind: 'manual' | 'daily' | 'weekly' | 'monthly' | 'on_push' | 'cron';
  time?: string;            // ISO time-of-day, e.g. '03:00Z' — for daily/weekly/monthly
  expr?: string;            // cron expression — for kind='cron'
  on_branches?: string[];   // for kind='on_push'
}

export interface TargetPosture {
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  info?: number;
  coverage_percent?: number;
  last_scan_status?: ScanStatus;
  last_scan_at?: string;
}

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
  // Added in migration 040 (target registry extension).
  // Optional/null on rows written before the migration.
  schedule: TargetSchedule | null;
  posture: TargetPosture | null;
  archived_at: string | null;
}

// ---------------- Per-org agent memory (migration 041) ----------------
//
// The wrapper's continuity-of-context layer. The chat agent reads from
// + writes to these on every meaningful turn.
//
// All three tables are RLS-scoped by org_id and never cross-tenanted.

export type AgentMemoryFactSource =
  | 'told_by_user'
  | 'inferred_from_repo'
  | 'inferred_from_scan'
  | 'derived_from_audit'
  | 'agent_decision';

export interface AgentMemoryFact {
  id: string;
  org_id: string;
  scope: string;        // 'stack' | 'team' | 'compliance' | 'suppression' | ...
  key: string;
  value: Record<string, unknown> | unknown[] | string | number | boolean | null;
  source: AgentMemoryFactSource;
  confidence: number;   // 0.0 - 1.0
  superseded_by: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AgentMemoryEpisode {
  id: string;
  org_id: string;
  thread_id: string | null;   // FK to agent_threads added in follow-up migration
  user_id: string | null;
  agent_action: string;       // 'finding_dismissed' | 'fix_applied' | 'scan_run' | 'rule_added' | ...
  payload: Record<string, unknown>;
  rationale: string | null;
  created_at: string;
}

export interface AgentAutonomyPrefs {
  default: 'ask_before_act' | 'autopilot' | string;
  auto_fix_severity: Severity | null;   // fix without asking at this severity and above
  auto_dismiss: boolean;
  slack_notify: 'always' | 'critical_only' | 'never' | string;
  // Per-category overrides — additive, future-extensible
  [category: string]: unknown;
}

export interface AgentVoicePrefs {
  tone: 'professional_friendly' | 'terse' | 'verbose' | string;
  verbosity: 'low' | 'mid' | 'high' | string;
  name: string;
}

export interface AgentChannelPrefs {
  slack_channel_id?: string | null;
  github_app_installation_id?: string | null;
  // Future: linear_team_id, jira_project_key, etc.
  [k: string]: unknown;
}

export interface AgentSchedulePrefs {
  daily_digest_time?: string;        // ISO time-of-day, e.g. '09:00Z'
  digest_channels?: string[];        // ['in_app', 'slack', 'email']
  [k: string]: unknown;
}

export interface AgentMemoryPreferences {
  org_id: string;
  autonomy: AgentAutonomyPrefs;
  voice: AgentVoicePrefs;
  channels: AgentChannelPrefs;
  schedule: AgentSchedulePrefs;
  updated_at: string;
  updated_by: string | null;
}

// ---------------- Conversational shell (migration 042) ----------------
//
// AgentBlock — the typed schema the agent emits and the wrapper renders.
// Unknown block types fall through to a collapsed-JSON renderer so
// adding a new type doesn't require a frontend deploy.

export type AgentBlock =
  | { type: 'text'; markdown: string }
  | { type: 'table'; columns: string[]; rows: unknown[][]; caption?: string }
  | { type: 'chart'; kind: 'line' | 'bar' | 'pie'; data: unknown; caption?: string }
  | { type: 'diff'; file: string; before: string; after: string; language?: string }
  | { type: 'code'; language: string; content: string; caption?: string }
  | { type: 'screenshot'; url: string; alt: string; caption?: string }
  | {
      type: 'timeline';
      events: { at: string; label: string; evidence?: unknown }[];
    }
  | { type: 'finding_ref'; finding_id: string }
  | { type: 'scan_ref'; scan_id: string }
  | { type: 'asset_ref'; target_id: string }
  | {
      type: 'pr_ref';
      provider: 'github' | 'gitlab' | 'bitbucket';
      url: string;
      title: string;
      status: string;
    };

export interface AgentCitation {
  kind: 'finding' | 'scan' | 'scan_event' | 'episode' | 'asset' | 'compliance_evidence';
  id: string;
  label?: string;
}

export interface AgentSuggestion {
  label: string;
  action: string;                         // 'apply_fix' | 'see_diff' | 'snooze' | …
  payload?: Record<string, unknown>;
}

export interface AgentAction {
  kind: string;                            // 'finding_dismissed' | 'fix_applied' | …
  target?: string;                         // generic id reference
  at: string;
  payload?: Record<string, unknown>;
}

export interface AgentThread {
  id: string;
  org_id: string;
  user_id: string | null;
  title: string | null;
  /**
   * Soft binding to a finding/scan/asset/onboarding the thread is about.
   * Examples: {kind:'finding', id:'<uuid>'} | {kind:'primary'} |
   * {kind:'onboarding'} | {kind:'daily_digest', date:'2026-05-23'}.
   */
  context: Record<string, unknown> | null;
  archived: boolean;
  created_at: string;
  last_message_at: string;
}

export interface AgentMessage {
  id: string;
  thread_id: string;
  org_id: string;
  role: 'user' | 'agent' | 'system' | 'tool';
  blocks: AgentBlock[];
  citations: AgentCitation[];
  suggestions: AgentSuggestion[] | null;
  reasoning_trace: string[] | null;
  confidence: number | null;
  acted_on: AgentAction[] | null;
  parent_id: string | null;
  created_at: string;
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
  // Public Trust Page (migration 047). Default false; flipped from
  // settings UI or directly via the trust-page API route.
  trust_page_enabled?: boolean;
  trust_page_subtitle?: string | null;
  trust_page_published_at?: string | null;
  // Slack chat-bridge opt-in (migration 048). Forwards agent_messages
  // to the org's configured Slack webhook.
  slack_bridge_enabled?: boolean;
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
  /** Plain-language scan summary (pillar 1 item 7). Generated by the
   *  worker post-triage, persisted as JSONB, rendered above the
   *  findings list on the scan detail page. Null until the worker
   *  successfully generates one (or for scans completed before this
   *  feature shipped). */
  summary?: ScanSummary | null;
  /** Engine PR #30 — passive recon mode toggle. When true, the worker
   *  forwards STRIX_DNS_ONLY=1 into the sandbox env. The scan page
   *  renders a "passive" badge on the run header. */
  dns_only?: boolean;
  /** Engine PR #117 — repository branch / tag / SHA picker. Worker
   *  forwards as `--branch <ref>` when set; null means use the repo's
   *  default branch. Only meaningful for repository-typed targets. */
  branch?: string | null;
  /** Engine PR #113 — cost-cap self-exit gates. Either may be null
   *  (no cap). The worker forwards as `--max-cost <usd>` /
   *  `--max-input-tokens <n>`; the engine self-exits with code 3 and
   *  emits `run.terminated{reason: "budget_exceeded"}` if either
   *  trips. */
  max_cost?: number | null;
  max_input_tokens?: number | null;
  /** Engine PR #29 — set by the worker when Strix's preflight bailed
   *  (target didn't resolve / no port answered). Distinct from a scan
   *  crash; UI renders an amber "Target unreachable" banner. */
  preflight_failed?: boolean;
  /** Engine PR #129 — auditor-grade evidence pack present in storage.
   *  Set by the worker after at least one file from the engine's
   *  `--compliance-pack` bundle landed under
   *  `<org_id>/<scan_id>/compliance_pack/`. UI keys the "Download
   *  compliance pack" button off this column to avoid dangling links
   *  when the engine didn't emit a pack. */
  compliance_pack_uploaded?: boolean;
  /** Engine `run_meta.json` persisted verbatim by the worker
   *  (migration 031). UI reads typed paths into the JSONB:
   *    - `vendor_risk` (engine PR #133) — 0-100 score + deductions
   *    - `mfa_attestation` (engine PR #132) — 4-point posture score
   *    - `compliance_posture` (engine PR #103) — cadence status
   *  Adding a new top-level signal is a UI change, not a schema
   *  change. Null when the engine didn't write a run_meta or the
   *  worker couldn't parse it. */
  run_meta?: RunMeta | null;
  /** Engine PR #131 — CycloneDX SBOM uploaded to scan-artifacts at
   *  `<org>/<scan>/sbom.cdx.json` (migration 032). UI keys the
   *  "View SBOM" / "Download CycloneDX" CTAs off this column. */
  sbom_uploaded?: boolean;
  /** Phase A #5 / migration 062 — SARIF auto-pushed to GitHub Code
   *  Scanning at scan-finalize. URL is the repo's Code Scanning
   *  landing page; null means the worker didn't upload (no SARIF
   *  artefact, target isn't a GitHub repo, or no integration_id). */
  code_scanning_url?: string | null;
  code_scanning_uploaded_at?: string | null;
  /** Tier II #7 / migration 066 — GitHub PR context, set when this
   *  scan was created by the /api/webhooks/github receiver. The
   *  PR comment dispatcher uses these to compose + post the sticky
   *  comment. All four null for scans not driven by a PR webhook. */
  github_owner?: string | null;
  github_repo?: string | null;
  github_pull_request_number?: number | null;
  github_head_sha?: string | null;
  /** Tier II #7 — sticky PR comment tracking. pr_comment_id is the
   *  GitHub comment we own (PATCHed on re-runs rather than POSTed
   *  fresh so the PR keeps one running comment, not N per push). */
  pr_comment_id?: number | null;
  pr_comment_url?: string | null;
  pr_comment_posted_at?: string | null;
  pr_comment_updated_at?: string | null;
  /** Engine PR #141 — HAR / Burp project imports persisted by the
   *  API route on scan creation (migration 035). Browser uploads to
   *  user-uploads bucket; worker downloads at scan-start. */
  imports?: ScanImport[] | null;
  /** Tier A — fix-verify targeted rescan (migration 036). When this
   *  scan was launched from a finding's "Verify fix" button, this
   *  column points back at the finding the scan is verifying. The
   *  scan page renders a "Verifying finding: <title>" badge on the
   *  header when set. */
  verifying_finding_id?: string | null;
  /** Engine `coverage.json` persisted verbatim by the worker
   *  (migration 039). Critical UX bridge: a 0-finding scan is
   *  ambiguous between "site is clean" and "agent gave up early";
   *  coverage tells you which. The amber banner on the scan page
   *  keys off `coverage.status === "incomplete"`. */
  coverage?: ScanCoverage | null;
}

export interface ScanCoverage {
  schema_version?: number;
  run_id?: string;
  run_name?: string;
  generated_at?: string;
  target_types?: string[];
  scan_mode?: string;
  /** Engine's required-checks list for the (target_type, scan_mode)
   *  combination — e.g. ["csrf","idor","open_redirect","sqli","ssrf","xss"]. */
  required?: string[];
  /** Engine subset of `required` that finished with a result
   *  (vulnerable / not_vulnerable / inconclusive). */
  completed?: string[];
  /** Engine subset of `required` that produced any signal (covered ⊆ required). */
  covered?: string[];
  /** required − covered. The list the UI banner reads from. */
  gaps?: string[];
  /** 0-100. UI compares against scan_mode to gate the thin-scan
   *  detector. */
  coverage_percent?: number;
  status?: 'complete' | 'incomplete' | string;
  [k: string]: unknown;
}

export interface ScanImport {
  kind: 'har' | 'burp';
  storage_path: string;
  filename: string;
  size_bytes: number;
}

// ---------------- CycloneDX 1.5 (subset the viewer renders) ----------------
//
// We only declare the fields the SBOM viewer actually reads. The
// `[k:string]:unknown` escape hatch on each interface preserves the
// rest of the spec for unknown-key forward-compat — auditors can
// always pull the raw file via `?format=cyclonedx`.

export interface CycloneDxBom {
  bomFormat?: string;
  specVersion?: string;
  serialNumber?: string;
  version?: number;
  metadata?: CycloneDxMetadata;
  components?: CycloneDxComponent[];
  vulnerabilities?: CycloneDxVulnerability[];
  [k: string]: unknown;
}

export interface CycloneDxMetadata {
  timestamp?: string;
  tools?: Array<{ vendor?: string; name?: string; version?: string }> | { components?: unknown[] };
  component?: CycloneDxComponent;
  [k: string]: unknown;
}

export interface CycloneDxComponent {
  'bom-ref'?: string;
  type?: 'application' | 'framework' | 'library' | 'container' | 'platform' | 'operating-system' | 'device' | 'firmware' | 'file' | string;
  name?: string;
  version?: string;
  description?: string;
  purl?: string;
  group?: string;
  scope?: 'required' | 'optional' | 'excluded' | string;
  licenses?: Array<{ license?: { id?: string; name?: string } }>;
  /** Engine #131 extension — what surface signal flagged the component. */
  detected_via?: string;
  /** Engine confidence on the detection (0.0–1.0). */
  confidence?: number;
  [k: string]: unknown;
}

export interface CycloneDxVulnerability {
  'bom-ref'?: string;
  id?: string;
  source?: { name?: string; url?: string };
  ratings?: Array<{ severity?: string; method?: string; score?: number }>;
  affects?: Array<{ ref?: string }>;
  [k: string]: unknown;
}

export interface RunMeta {
  vendor_risk?: VendorRisk;
  mfa_attestation?: MfaAttestation;
  compliance_posture?: CompliancePosture;
  monitoring_posture?: MonitoringPosture;
  /** Engines may add additional top-level signals over time. The
   *  open shape is forward-compatible — a new key the wrapper doesn't
   *  know about is preserved on the row and ignored by the UI. */
  [k: string]: unknown;
}

export interface VendorRisk {
  /** 0-100, higher = safer (engine convention). */
  score?: number;
  band?: 'low_risk' | 'medium_risk' | 'high_risk' | string;
  /** Map of category → deduction (negative number). */
  deductions_by_category?: Record<string, number>;
  recommendation?: string;
  [k: string]: unknown;
}

export interface MfaAttestation {
  /** 0-4 (engine PR #132 convention). */
  score?: number;
  max?: number;
  breakdown?: {
    login_tokens?: boolean;
    challenge_keys?: boolean;
    webauthn_header?: boolean;
    mfa_setup_paths?: boolean;
    [k: string]: unknown;
  };
  attestation_text?: string;
  [k: string]: unknown;
}

export interface CompliancePosture {
  cadence_status?: 'In compliance' | 'Overdue' | string;
  audit_log_retention_days?: number;
  days_since_last_scan?: number;
  [k: string]: unknown;
}

export interface MonitoringPosture {
  /** 0-6 score (engine PR #128 convention). */
  score?: number;
  max?: number;
  /** Engine emits a structured breakdown across the 6 axes —
   *  redaction (3 axes) + reporting (2 axes) + rate-limit (1 axis).
   *  Keys may evolve; we render whatever booleans are present. */
  breakdown?: {
    pii_redaction?: boolean;
    secrets_redaction?: boolean;
    auth_redaction?: boolean;
    csp_reporting?: boolean;
    error_reporting?: boolean;
    rate_limit_observed?: boolean;
    [k: string]: unknown;
  };
  /** Free-form recommendation text from the engine. */
  recommendation?: string;
  [k: string]: unknown;
}

export interface ScanSummary {
  text: string;
  model: string;
  generated_at: string;
  stats: {
    findings_total: number;
    fix_now: number;
    fix_soon: number;
    monitor: number;
    dismiss_or_fp: number;
    endpoints_touched: number;
  };
}

/**
 * Cross-scan recurrence roll-up at scan level (pillar 1 item 5).
 * Returned by the `scan_recurrence_summary(scan_id)` RPC. Counts findings
 * detected in this scan that were *also* seen in prior scans, broken
 * down by current state. Null when this scan has no recurring findings.
 */
export interface ScanRecurrenceSummary {
  total: number;
  still_active: number;
  fixed: number;
  dismissed: number;
  reopened: number;
}

/**
 * Tier II #13 — org-declared compensating control for a failing
 * framework control. Surfaces on the trust page next to the failing
 * control with an amber "compensated" badge.
 */
export interface CompensatingControl {
  id: string;
  framework: string;
  control_id: string;
  title: string;
  rationale: string;
  evidence_links: string[];
  effective_from: string;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  /** True when expires_at is within 30 days — UI surfaces a "review
   *  due soon" chip on the row. Only returned by the
   *  compensating_controls_active() RPC. */
  review_due_soon?: boolean;
}

/**
 * Tier II #13 — one row of the static cross-framework equivalence
 * table. Returned by `equivalent_controls(framework, control_id)`.
 */
export interface ControlMappingRow {
  group_key: string;
  group_name: string;
  framework: string;
  control_id: string;
  control_label: string | null;
}

/**
 * Tier II #12 — Audit-readiness score for one framework.
 *
 * Returned by `compute_org_audit_readiness()`. The `prev_*` columns
 * carry the previous-quarter snapshot for delta display ("was 68 last
 * quarter") — both may be null when no snapshot yet exists.
 *
 * Note: all columns are prefixed `out_` in the RPC's RETURNS TABLE
 * to dodge PG's identifier-shadowing rule (column names shadow OUT
 * params in plpgsql). The TS shape strips that prefix for ergonomic
 * consumption — the page code reads `row.framework` not `row.out_framework`.
 */
export interface AuditReadinessRow {
  framework: string;
  composite_pct: number;
  base_readiness_pct: number;
  coverage_pct: number;
  cadence_pct: number;
  findings_pct: number;
  freshness_pct: number;
  open_crit_findings: number;
  open_high_findings: number;
  stale_controls: number;
  total_controls: number;
  touched_controls: number;
  days_since_last_scan: number;
  prev_quarter: string | null;
  prev_score: number | null;
}

/**
 * Tier II #12 — one quarter's snapshot row from `compliance_snapshots`.
 * Drives the "Q1: 68 → Q2: 81" history graph on /compliance/readiness.
 */
export interface ComplianceSnapshot {
  id: string;
  org_id: string;
  framework: string;
  /** YYYY-Q[1-4] (e.g. "2026-Q2"). */
  quarter: string;
  score: number;
  breakdown: {
    base_readiness_pct: number;
    coverage_pct: number;
    cadence_pct: number;
    findings_pct: number;
    freshness_pct: number;
    open_crit_findings: number;
    open_high_findings: number;
    stale_controls: number;
    total_controls: number;
    touched_controls: number;
    days_since_last_scan: number;
  };
  snapshot_at: string;
}

/**
 * Tier II #11 — Cross-scan finding rollup.
 *
 * One row per fingerprint that hits >= 2 distinct targets in the org.
 * Returned by `fingerprint_rollup()`. The canonical title / severity /
 * CWE / CVE come from the most-recent occurrence; the counts are over
 * the full set of occurrences (including pre-resolved ones).
 */
export interface FingerprintRollupRow {
  fingerprint: string;
  title: string;
  severity: Severity;
  cwe: string | null;
  cve: string | null;
  occurrence_count: number;
  target_count: number;
  open_count: number;
  triaged_real_count: number;
  fixed_count: number;
  false_positive_count: number;
  wont_fix_count: number;
  first_seen_at: string;
  last_seen_at: string;
  /** Highest urgency tier observed across occurrences. fix_now wins
   *  over fix_soon > monitor > dismiss. null when no occurrence has
   *  an ai_assessment. */
  max_urgency: 'fix_now' | 'fix_soon' | 'monitor' | 'dismiss' | null;
}

/**
 * Tier II #11 — drill-in row for `fingerprint_targets(p_fingerprint)`.
 * One row per occurrence of the fingerprint across all targets in
 * the org, ordered open-first then by recency.
 */
export interface FingerprintTargetRow {
  finding_id: string;
  target_id: string | null;
  target_name: string | null;
  target_value: string | null;
  target_type: string | null;
  scan_id: string;
  scan_name: string;
  status: FindingStatus;
  severity: Severity;
  created_at: string;
  last_seen_at: string | null;
  times_seen: number | null;
}

/**
 * One step in the heuristic "kill-chain" reconstruction (pillar 1 item 2).
 * The `event_type` is from Strix's vocabulary; the `payload` is the raw
 * scan_event payload. UI extracts a friendly label per event_type.
 */
export interface KillChainStep {
  created_at: string;
  event_type: string;
  payload: Record<string, unknown> | null;
}

export interface KillChainResponse {
  agent_id: string | null;
  finding_at: string;
  steps: KillChainStep[];
}

export interface ScanTarget {
  id: string;
  scan_id: string;
  type: 'local_code' | 'repository' | 'web_application' | 'api' | 'container_image' | 'cloud_account' | 'domain' | 'ip_address';
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
  /**
   * Snapshot of the prediction + policy decision that drove an
   * auto-dismiss. Populated only when status = 'dismissed_by_ai'.
   * The UI shows it in the "AI auto-dismissed" banner so the user
   * can see why and override.
   */
  auto_dismiss_reason?: AutoDismissReason | null;

  // ============== ENGINE-SIDE SIGNALS (migration 024) ==============
  // Populated when the worker reads the engine's vulnerabilities.json
  // (ClatTribe/strix PR #137 + #142). Null on findings ingested via the
  // legacy markdown path or from older Strix versions. Per the doctrine,
  // the UI prefers these over wrapper-side derivations when present.

  /** Semantic category from the engine's enum: `info_disclosure`, `dns_security`,
   *  `email_security`, `sqli`, `xss`, `ssrf`, `secret_leak`, etc. */
  category?: string | null;
  /** Plain-language description for non-tech readers (160-ish chars). */
  description_plain?: string | null;
  /** One-sentence concrete next action. */
  recommended_action?: string | null;
  /** Engine's user-time-aware priority: `fix_now` / `fix_soon` / `monitor`
   *  / `informational` / `low_priority`. Distinct from our wrapper-side
   *  `ai_assessment.urgency`. */
  priority_label?: string | null;
  /** `verified` / `pattern_match` / `inconclusive` / `could_not_verify`. */
  verification_status?: string | null;
  /** 0.0–1.0 engine confidence. */
  confidence?: number | null;
  /** Cross-run dedup key (SHA-256 over reasoning_trace + kill_chain + target_state). */
  reproducibility_token?: string | null;
  fingerprint_version?: number | null;
  /** Cross-tool dedup canonical flag (engine PR #98). UI hides non-canonical by default. */
  is_canonical?: boolean | null;
  /** "Why this is exploitable" bullets (≤20 × 320 chars). Engine PR #137. */
  reasoning_trace?: string[] | null;
  /** Alternative-explanation block — auditor-grade trust signal. Engine PR #137. */
  counter_proof?: { description?: string; evidence?: string } | null;
  /** Multi-step kill chain. Each step has step_number, type (one of 7 enum
   *  values), description, optional tool + evidence. Engine PR #36. */
  kill_chain?: KillChainPayload | null;
  /** Mapping of compliance frameworks → control IDs implicated by this finding.
   *  Engine PR #103. */
  compliance_controls?: ComplianceControls | null;
  /** Engine PR #292 — drift correlation classification. Set when a
   *  scan included BOTH a `repository` target (IaC) AND a
   *  `cloud_account` target (CSPM) and the engine cross-referenced
   *  them. Null on any single-target scan.
   *
   *  Semantics:
   *    iac_root_cause     IaC + CSPM agree → fix the IaC, re-apply
   *    drift              CSPM-only finding → resource drifted out of IaC
   *                       (severity is bumped one tier — IaC ≠ live is
   *                       itself an operational signal)
   *    iac_unfollowed     IaC says misconfig but live is clean → IaC
   *                       hasn't been applied; next apply will reintroduce
   *    uncorrelated_cspm  live-only attestation, no IaC analog */
  drift_classification?:
    | 'iac_root_cause'
    | 'drift'
    | 'iac_unfollowed'
    | 'uncorrelated_cspm'
    | null;
  /** `pii` / `phi` / `pci` / `credentials` / `internal` / null. */
  data_classification?: string | null;
  /** MITRE ATT&CK technique IDs. */
  mitre_attack?: string[] | null;
  owasp_top_10?: string | null;
  owasp_api_top_10?: string | null;
  /** Full features block from RLHF Phase 1 (engine PR #142). */
  features?: Record<string, unknown> | null;
  /** Engine-side auto-dismiss (driven by feedback.jsonl prior FP). Distinct
   *  from wrapper-side `dismissed_by_ai` (KNN-driven). */
  engine_auto_dismissed?: boolean | null;
  engine_auto_dismissal_reason?: string | null;
  severity_pre_auto_dismissal?: string | null;
  prior_label_attribution?: PriorLabelAttribution | null;
  /** Per-finding reasoning trail from <run_dir>/trajectory.jsonl (engine
   *  PR #142). Joined by finding_id at ingest. The wrapper persists the
   *  whole record verbatim; the UI lazy-renders the "How did the engine
   *  arrive at this?" panel from these fields. */
  trajectory?: TrajectoryRecord | null;
  /** Patcher specialist (strix PRs #243 / #250 / migration 058). One
   *  unified-diff proposal per finding. status ∈
   *  `proposed | applied | verified | failed`. UI renders these as the
   *  "Suggested fix" expandable panel on the finding card. */
  patch_id?: string | null;
  patch_diff?: string | null;
  patch_commit_message?: string | null;
  patch_status?: string | null;
  patch_verified_at?: string | null;
  patch_proposed_at?: string | null;
  /** Patcher → PR flow (wrapper migration 060). Set when a user clicks
   *  "Apply as PR" and the wrapper opens a GitHub PR with the engine's
   *  diff. Never set by the engine. */
  patch_pr_url?: string | null;
  patch_applied_at?: string | null;
  /** Phase B #7 / migration 063 — risk-acceptance metadata when the
   *  user marked this finding `wont_fix`. Required reason; optional
   *  expiry timestamp (after which the finding visually surfaces as
   *  an expired acceptance). Engine never sets these — wrapper UI
   *  writes them via the triage flow. */
  wont_fix_reason?: string | null;
  risk_acceptance_expires_at?: string | null;
  /** Tier I #6 / migration 065 — collaboration metadata. assignee_id
   *  references auth.users(id) directly so the FK stays valid if a
   *  member is moved between orgs. due_at is auto-set on triage by
   *  severity SLA when missing; sla_severity_tier captures the tier
   *  the due-date came from so a severity bump doesn't silently
   *  reset it. */
  assignee_id?: string | null;
  due_at?: string | null;
  sla_severity_tier?: string | null;
}

/** Tier I #6 / migration 065 — per-finding discussion thread. */
export interface FindingComment {
  id: string;
  finding_id: string;
  org_id: string;
  user_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface TrajectoryRecord {
  finding_id?: string;
  /** Loop count the agent took before emitting this finding. */
  iterations_to_emit?: number;
  /** Wall-clock seconds from agent start to finding emit. */
  time_to_emit_seconds?: number;
  /** Number of distinct tools/surfaces the agent explored. */
  exploration_breadth?: number;
  /** Collapsed event timeline — each entry is a tool call snapshot. */
  events_compact?: TrajectoryEventCompact[];
  /** Hypotheses the agent considered and rejected, with reasons. */
  dismissed_alternatives?: Array<{ hypothesis?: string; reason?: string; evidence?: string }>;
  schema_version?: number;
  [k: string]: unknown;
}

export interface TrajectoryEventCompact {
  tool?: string;
  target?: string;
  provenance?:
    | 'trusted_source'
    | 'intel_feed'
    | 'target'
    | 'operator_input'
    | 'framework'
    | 'mixed';
  status?: 'started' | 'completed' | 'failed';
  /** Optional brief result note — engine-truncated. */
  note?: string;
  [k: string]: unknown;
}

export interface KillChainPayload {
  step_count?: number;
  chain?: KillChainStepEngine[];
}

export interface KillChainStepEngine {
  step_number: number;
  type: 'recon' | 'discovery' | 'exploitation' | 'escalation' | 'lateral_movement' | 'impact' | 'validation';
  description: string;
  tool?: string;
  evidence?: string;
}

export interface ComplianceControls {
  soc2?: string[];
  pci_dss?: string[];
  hipaa?: string[];
  gdpr?: string[];
  iso_27001?: string[];
  nist_800_53?: string[];
  owasp?: string[];
  // Engine PR #289 — CIS Cloud benchmark mappings. Emitted by CSPM
  // specialists (PRs #290 / #291) and by IaC parsers (PR #287). Keys
  // mirror the engine's framework registry; the wrapper renders them
  // alongside the app-side frameworks above.
  cis_aws?: string[];
  cis_gcp?: string[];
  cis_azure?: string[];
  cis_kubernetes?: string[];
  cis_docker?: string[];
}

export interface PriorLabelAttribution {
  verdict: string;
  fp_reason?: string;
  labeler: { id: string; role?: string };
  labeled_at: string;
  label_id: string;
  scan_run_id: string;
}

export interface AutoDismissReason {
  p_false_positive: number;
  n_neighbours: number;
  mean_similarity?: number;
  threshold: number;
  decided_at: string;
  /** True if epsilon-greedy fired and we surfaced anyway (rare; stays absent otherwise). */
  epsilon_explore?: boolean;
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
