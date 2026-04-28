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
  times_seen?: number | null;
  last_seen_at?: string | null;
  last_seen_scan_id?: string | null;
  ai_assessment?: AiAssessment | null;
  ai_assessed_at?: string | null;
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
