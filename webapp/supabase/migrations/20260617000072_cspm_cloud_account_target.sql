-- Engine PRs #287/#290/#291/#292 — CSPM + IaC + drift correlation.
--
-- Engine landed four CSPM/IaC-shaped specialists last week (see
-- ClatTribe/strix#287/#290/#291/#292). Wrapper is the missing link:
--
--   - PR #290 (boto3 AWS posture scanner) + PR #291 (Prowler multi-
--     cloud wrapper) introduce a new target shape: `cloud_account`.
--     The engine's standard credential chain expects boto3 env vars
--     (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION) OR a
--     role_arn for cross-account scanning.
--
--   - PR #287 (Terraform / K8s / Helm parsers) ships IaC scanning
--     *inside* existing repository scans — no new target type
--     required. Findings flow through the existing `repository`
--     pathway automatically; wrapper just needs to surface the new
--     compliance_controls keys (cis_aws, cis_kubernetes, etc.).
--
--   - PR #292 (drift correlation) classifies findings into four
--     buckets (iac_root_cause / drift / iac_unfollowed /
--     uncorrelated_cspm). Engine emits via tracer.category=drift;
--     wrapper persists this in finding payload — no schema change
--     needed since findings.kind is open-text.
--
-- This migration is **just the schema gate** for `cloud_account` —
-- the rest of the plumbing (worker AWS-env forwarding, target UI,
-- finding labels) happens in code without further DB changes.

-- ============================================================================
-- 1. Widen CHECK constraints
-- ============================================================================

alter table public.targets
  drop constraint targets_type_check;
alter table public.targets
  add constraint targets_type_check
  check (type in (
    'local_code',
    'repository',
    'web_application',
    'domain',
    'ip_address',
    'api',
    'container_image',
    'cloud_account'
  ));

alter table public.scan_targets
  drop constraint scan_targets_type_check;
alter table public.scan_targets
  add constraint scan_targets_type_check
  check (type in (
    'local_code',
    'repository',
    'web_application',
    'domain',
    'ip_address',
    'api',
    'container_image',
    'cloud_account'
  ));

comment on column public.targets.type is
  'Target taxonomy. `cloud_account` (added 2026-05-17) covers AWS / '
  'GCP / Azure / Kubernetes posture scans via the engine''s CSPM '
  'specialists (engine PRs #290/#291). Value format: ''<provider>/<account_id>'' '
  '(e.g. ''aws/123456789012'') — provider drives engine dispatch, '
  'account_id is optional contextual metadata.';

-- ============================================================================
-- 2. CIS framework label catalog (UI-only)
-- ============================================================================
--
-- Engine PR #289 emits `compliance_controls` keys with new buckets:
-- `cis_aws`, `cis_azure`, `cis_gcp`, `cis_kubernetes`, `cis_docker`.
-- Wrapper's `FRAMEWORK_LABEL` maps live in TypeScript today; rather
-- than make every consumer extend its own map, we ship the labels
-- in a lookup table the UI can read once on render.
--
-- We don't enforce a foreign key from findings.compliance_controls
-- to this table — the engine remains the source of truth for which
-- frameworks exist, and we just maintain friendly names for the
-- ones we know about. A missing label falls back to the raw key
-- (e.g. `cis_oci` would render as `cis_oci`).

create table if not exists public.compliance_framework_labels (
  framework_key   text primary key,
  display_name    text not null,
  short_name      text not null,
  category        text not null check (category in ('cloud', 'app', 'process', 'industry')),
  description     text,
  url             text
);

alter table public.compliance_framework_labels enable row level security;
drop policy if exists framework_labels_public_read on public.compliance_framework_labels;
create policy framework_labels_public_read on public.compliance_framework_labels
  for select using (true); -- catalog is non-tenant; anyone can read

insert into public.compliance_framework_labels
  (framework_key, display_name, short_name, category, description, url)
values
  ('cis_aws',         'CIS AWS Foundations Benchmark v3.0',     'CIS AWS',         'cloud',    'Foundational CIS-mapped controls for AWS accounts (S3, EC2, IAM, RDS, EBS, CloudTrail, VPC).', 'https://www.cisecurity.org/benchmark/amazon_web_services'),
  ('cis_gcp',         'CIS Google Cloud Platform Benchmark',    'CIS GCP',         'cloud',    'Foundational CIS-mapped controls for GCP projects.',  'https://www.cisecurity.org/benchmark/google_cloud_computing_platform'),
  ('cis_azure',       'CIS Microsoft Azure Foundations Benchmark', 'CIS Azure',     'cloud',    'Foundational CIS-mapped controls for Azure subscriptions.', 'https://www.cisecurity.org/benchmark/azure'),
  ('cis_kubernetes',  'CIS Kubernetes Benchmark',               'CIS K8s',         'cloud',    'Per-pod and cluster-level Kubernetes posture checks.', 'https://www.cisecurity.org/benchmark/kubernetes'),
  ('cis_docker',      'CIS Docker Benchmark',                   'CIS Docker',      'cloud',    'Container daemon + image hardening checklist.',  'https://www.cisecurity.org/benchmark/docker'),
  -- The app-side ones too so the UI has a single source-of-truth table
  ('soc2',            'SOC 2 Type II',                          'SOC 2',           'process',  'AICPA Trust Services Criteria.', null),
  ('iso_27001',       'ISO 27001:2022',                         'ISO 27001',       'process',  'ISO/IEC 27001 information security management system.', null),
  ('pci_dss',         'PCI DSS 4.0',                            'PCI',             'industry', 'Payment Card Industry Data Security Standard.', null),
  ('hipaa',           'HIPAA Security Rule',                    'HIPAA',           'industry', '45 CFR Part 164 Subpart C (Technical / Administrative / Physical safeguards).', null),
  ('nist_800_53',     'NIST SP 800-53 Rev 5',                   'NIST 800-53',     'process',  'Federal control catalog; baseline for FedRAMP.', null),
  ('gdpr',            'GDPR',                                   'GDPR',            'industry', 'EU General Data Protection Regulation.', null),
  ('owasp',           'OWASP Top 10',                           'OWASP',           'app',      'Most-critical web application security risks.', null),
  ('fedramp_high',    'FedRAMP High',                           'FedRAMP High',    'process',  'US federal high-impact baseline (NIST 800-53 superset).', null)
on conflict (framework_key) do update
  set display_name = excluded.display_name,
      short_name   = excluded.short_name,
      category     = excluded.category,
      description  = excluded.description,
      url          = excluded.url;

comment on table public.compliance_framework_labels is
  'Tier II CSPM — friendly names + categories for the compliance-control '
  'buckets the engine emits in findings.compliance_controls. UI consumers '
  'read this once per render rather than maintaining a per-component map.';

-- ============================================================================
-- 3. Drift correlation event types — documented in scan_events vocabulary
-- ============================================================================
--
-- `scan_events.event_type` is `text` and accepts any value the engine emits,
-- so engine PR #292's `tracer.category=drift` finding payload doesn't need
-- a schema change. This comment block documents the values the wrapper UI
-- expects to render with the drift badge:
--
--   drift            CSPM flags it, IaC didn't — resource drifted out of IaC
--   iac_root_cause   both sides flag it — fix IaC and the drift clears
--   iac_unfollowed   IaC says misconfig, live is clean — IaC un-applied
--   uncorrelated_cspm  live-only attestation, no IaC analog
--
-- Findings carry the classification in `kind` or in compliance_controls;
-- the UI keys off whichever the engine ships and falls back to the
-- existing severity tone.
