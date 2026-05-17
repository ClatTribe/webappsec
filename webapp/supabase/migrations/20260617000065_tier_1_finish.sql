-- Tier I finish — three deliverables in one migration.
--
-- 1. GRC questionnaire templates: ISO 27001 (Annex A 2022), PCI DSS 4.0,
--    NIST 800-53 (subset of AC / AU / IA / SI families). Mirrors the
--    SOC 2 SAQ + HIPAA SAQ pattern from migration 053 + 059. Each row
--    maps a question to one or more compliance_evidence control_ids
--    so org_questionnaire_response can drive answer_status from the
--    engine's verdicts.
--
-- 2. Per-finding collaboration columns:
--    - findings.assignee_id uuid — who owns this finding. References
--      auth.users(id) directly rather than org_members so the FK
--      stays valid if a member is moved between orgs.
--    - findings.due_at timestamptz — when this finding must be
--      resolved by. Auto-set on triage if missing per severity SLA.
--    - findings.sla_severity_tier text — captures the tier the SLA
--      came from so a severity bump doesn't silently reset the due
--      date.
--
-- 3. finding_comments table: thread-per-finding for security-team
--    discussion. Append-only audit trail; soft-delete via deleted_at
--    so the audit pack still shows the redacted-comment placeholder
--    rather than a memory hole.

-- ============================================================================
-- 1a. ISO 27001 Annex A SAQ — 15 high-yield controls
-- ============================================================================

insert into public.compliance_questionnaire_templates
  (key, framework, position, section, question_id, question, control_ids, note)
values
  ('iso27001_saq_v1', 'iso_27001',  1, 'A.5 — Organisational controls',
   'A.5.1', 'Have you documented and approved an information-security policy?',
   array['A.5.1'],
   'Policy authorship sits outside the scan posture; the questionnaire pulls a verdict from compliance_evidence if your auditor has logged one.'),

  ('iso27001_saq_v1', 'iso_27001',  2, 'A.5 — Organisational controls',
   'A.5.23', 'Do you have a process for managing information security in supplier relationships?',
   array['A.5.23'],
   null),

  ('iso27001_saq_v1', 'iso_27001',  3, 'A.5 — Organisational controls',
   'A.5.30', 'Do you have an ICT readiness for business continuity plan?',
   array['A.5.30'],
   null),

  ('iso27001_saq_v1', 'iso_27001',  4, 'A.6 — People controls',
   'A.6.3', 'Do you provide information-security awareness training to all employees and relevant contractors?',
   array['A.6.3'],
   null),

  ('iso27001_saq_v1', 'iso_27001',  5, 'A.8 — Technological controls',
   'A.8.2', 'Are privileged access rights restricted and managed under formal authorisation?',
   array['A.8.2'],
   'TensorShield surfaces unprivileged accounts that have privileged paths as auth-bypass findings.'),

  ('iso27001_saq_v1', 'iso_27001',  6, 'A.8 — Technological controls',
   'A.8.5', 'Do you enforce strong authentication for users (including MFA where applicable)?',
   array['A.8.5'],
   null),

  ('iso27001_saq_v1', 'iso_27001',  7, 'A.8 — Technological controls',
   'A.8.8', 'Do you manage technical vulnerabilities of information systems in use?',
   array['A.8.8'],
   'TensorShield IS the technical-vulnerability management process for this control.'),

  ('iso27001_saq_v1', 'iso_27001',  8, 'A.8 — Technological controls',
   'A.8.9', 'Have you established a process for configuration management of systems?',
   array['A.8.9'],
   null),

  ('iso27001_saq_v1', 'iso_27001',  9, 'A.8 — Technological controls',
   'A.8.15', 'Do you log and review events that may have security relevance?',
   array['A.8.15'],
   null),

  ('iso27001_saq_v1', 'iso_27001', 10, 'A.8 — Technological controls',
   'A.8.16', 'Do you monitor systems for anomalous behaviour to detect potential information security incidents?',
   array['A.8.16'],
   null),

  ('iso27001_saq_v1', 'iso_27001', 11, 'A.8 — Technological controls',
   'A.8.24', 'Do you have rules for the effective use of cryptography, including key management?',
   array['A.8.24'],
   null),

  ('iso27001_saq_v1', 'iso_27001', 12, 'A.8 — Technological controls',
   'A.8.25', 'Do you establish principles for secure development life cycle?',
   array['A.8.25'],
   'Diff-aware SAST + scheduled scans give you a continuous SDLC posture.'),

  ('iso27001_saq_v1', 'iso_27001', 13, 'A.8 — Technological controls',
   'A.8.26', 'Do you identify, document, and review application security requirements?',
   array['A.8.26'],
   null),

  ('iso27001_saq_v1', 'iso_27001', 14, 'A.8 — Technological controls',
   'A.8.28', 'Do you follow secure coding principles?',
   array['A.8.28'],
   null),

  ('iso27001_saq_v1', 'iso_27001', 15, 'A.8 — Technological controls',
   'A.8.29', 'Do you test the security of applications before deployment?',
   array['A.8.29'],
   null)
on conflict (key, question_id) do nothing;

-- ============================================================================
-- 1b. PCI DSS 4.0 SAQ — 12 requirements
-- ============================================================================

insert into public.compliance_questionnaire_templates
  (key, framework, position, section, question_id, question, control_ids, note)
values
  ('pci_dss_v4_saq', 'pci_dss',  1, 'Build & Maintain Secure Networks',
   '1', 'Do you install and maintain network security controls (firewalls, network ACLs) to protect cardholder data?',
   array['1.1','1.2','1.3','1.4','1.5'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  2, 'Build & Maintain Secure Networks',
   '2', 'Do you apply secure configurations to all system components (no vendor defaults)?',
   array['2.1','2.2','2.3'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  3, 'Protect Account Data',
   '3', 'Do you protect stored account data (encryption, key management, masking)?',
   array['3.1','3.2','3.3','3.4','3.5','3.6','3.7'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  4, 'Protect Account Data',
   '4', 'Do you protect cardholder data with strong cryptography during transmission?',
   array['4.1','4.2'],
   'TensorShield flags plaintext-HTTP banking endpoints + weak TLS configs as critical findings.'),

  ('pci_dss_v4_saq', 'pci_dss',  5, 'Maintain a Vulnerability Management Program',
   '5', 'Do you protect all systems and networks from malicious software?',
   array['5.1','5.2','5.3','5.4'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  6, 'Maintain a Vulnerability Management Program',
   '6', 'Do you develop and maintain secure systems and software (vulnerability management + secure SDLC)?',
   array['6.1','6.2','6.3','6.4','6.5'],
   'TensorShield IS your continuous vulnerability scanner for this requirement; SCA + SAST + DAST coverage feeds 6.2 + 6.3.'),

  ('pci_dss_v4_saq', 'pci_dss',  7, 'Implement Strong Access Control',
   '7', 'Do you restrict access to system components and cardholder data by business need-to-know?',
   array['7.1','7.2','7.3'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  8, 'Implement Strong Access Control',
   '8', 'Do you identify users and authenticate access to system components?',
   array['8.1','8.2','8.3','8.4','8.5','8.6'],
   null),

  ('pci_dss_v4_saq', 'pci_dss',  9, 'Implement Strong Access Control',
   '9', 'Do you restrict physical access to cardholder data?',
   array['9.1','9.2','9.3','9.4','9.5'],
   'Out-of-scope for the automated scan posture but included so the export is complete.'),

  ('pci_dss_v4_saq', 'pci_dss', 10, 'Monitor & Test Networks',
   '10', 'Do you log and monitor all access to system components and cardholder data?',
   array['10.1','10.2','10.3','10.4','10.5','10.6','10.7'],
   null),

  ('pci_dss_v4_saq', 'pci_dss', 11, 'Monitor & Test Networks',
   '11', 'Do you test the security of systems and networks regularly (incl. external + internal pen tests)?',
   array['11.1','11.2','11.3','11.4','11.5','11.6'],
   'Quarterly external scans + annual pen-tests; TensorShield satisfies the scan cadence requirement.'),

  ('pci_dss_v4_saq', 'pci_dss', 12, 'Maintain an Information Security Policy',
   '12', 'Do you have an information security policy that supports the protection of cardholder data?',
   array['12.1','12.2','12.3','12.4','12.5','12.6','12.7','12.8','12.9','12.10'],
   null)
on conflict (key, question_id) do nothing;

-- ============================================================================
-- 1c. NIST 800-53 Rev 5 SAQ — subset of AC / AU / IA / SI families (12 questions)
-- ============================================================================

insert into public.compliance_questionnaire_templates
  (key, framework, position, section, question_id, question, control_ids, note)
values
  ('nist_800_53_saq_v1', 'nist_800_53',  1, 'AC — Access Control',
   'AC-2', 'Do you manage information system accounts (lifecycle, types, group memberships, attributes)?',
   array['AC-2'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  2, 'AC — Access Control',
   'AC-3', 'Do you enforce approved authorizations for logical access to information and system resources?',
   array['AC-3'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  3, 'AC — Access Control',
   'AC-6', 'Do you employ the principle of least privilege for users and system processes?',
   array['AC-6'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  4, 'AC — Access Control',
   'AC-17', 'Do you control remote access (allowed methods, encryption, monitoring)?',
   array['AC-17'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  5, 'AU — Audit & Accountability',
   'AU-2', 'Do you identify event types that the system is capable of logging?',
   array['AU-2'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  6, 'AU — Audit & Accountability',
   'AU-6', 'Do you review and analyze information system audit records for indications of inappropriate activity?',
   array['AU-6'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  7, 'IA — Identification & Authentication',
   'IA-2', 'Do you uniquely identify and authenticate organizational users?',
   array['IA-2'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  8, 'IA — Identification & Authentication',
   'IA-5', 'Do you manage information system authenticators (passwords, tokens, certificates)?',
   array['IA-5'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53',  9, 'SI — System & Information Integrity',
   'SI-2', 'Do you identify, report, and correct system flaws in a timely manner?',
   array['SI-2'],
   'TensorShield is your continuous flaw-identification mechanism — SI-2 maps directly to scan cadence + finding triage.'),

  ('nist_800_53_saq_v1', 'nist_800_53', 10, 'SI — System & Information Integrity',
   'SI-3', 'Do you employ malicious code protection mechanisms at system entry/exit points?',
   array['SI-3'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53', 11, 'SI — System & Information Integrity',
   'SI-4', 'Do you monitor the information system to detect attacks and indicators of potential attacks?',
   array['SI-4'],
   null),

  ('nist_800_53_saq_v1', 'nist_800_53', 12, 'SI — System & Information Integrity',
   'SI-10', 'Do you check the validity of information inputs to the information system?',
   array['SI-10'],
   'Input-validation is the wheelhouse of every scan_xss / scan_sqli / scan_idor specialist — SI-10 maps to your scan posture directly.')
on conflict (key, question_id) do nothing;

-- ============================================================================
-- 2. Per-finding collaboration columns
-- ============================================================================

alter table public.findings
  add column if not exists assignee_id uuid references auth.users(id) on delete set null,
  add column if not exists due_at timestamptz,
  add column if not exists sla_severity_tier text;

create index if not exists findings_assignee
  on public.findings (org_id, assignee_id)
  where assignee_id is not null;
create index if not exists findings_due_soon
  on public.findings (org_id, due_at)
  where due_at is not null and status = 'open';

comment on column public.findings.assignee_id is
  'Tier I #6 — who owns this finding. Set via the triage UI; cleared '
  'when status flips to fixed / false_positive / wont_fix.';
comment on column public.findings.due_at is
  'Tier I #6 — when this finding must be resolved by. Auto-set on '
  'triage by severity SLA (critical=7d, high=14d, medium=30d, low=90d) '
  'when missing. Surfaces an amber chip on the finding card when '
  'within 24h; rose chip when past due.';

-- ============================================================================
-- 3. finding_comments — thread-per-finding for security-team discussion
-- ============================================================================

create table if not exists public.finding_comments (
  id          uuid primary key default gen_random_uuid(),
  finding_id  uuid not null references public.findings(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id),
  body        text not null check (length(body) between 1 and 16384),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Soft-delete. The auditor pack still renders a "[redacted]"
  -- placeholder rather than a memory hole — critical for SOC 2 audit
  -- trail integrity.
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id)
);

create index if not exists finding_comments_finding
  on public.finding_comments (finding_id, created_at desc);
create index if not exists finding_comments_org
  on public.finding_comments (org_id, created_at desc);

comment on table public.finding_comments is
  'Tier I #6 — security-team discussion thread per finding. Append-only '
  'audit trail; soft-delete via deleted_at preserves the trail.';

alter table public.finding_comments enable row level security;

drop policy if exists finding_comments_org_read on public.finding_comments;
create policy finding_comments_org_read on public.finding_comments
  for select using (org_id = public.current_org_id());

drop policy if exists finding_comments_org_insert on public.finding_comments;
create policy finding_comments_org_insert on public.finding_comments
  for insert with check (
    org_id = public.current_org_id() and user_id = auth.uid()
  );

drop policy if exists finding_comments_author_update on public.finding_comments;
create policy finding_comments_author_update on public.finding_comments
  for update using (
    org_id = public.current_org_id() and user_id = auth.uid()
  );
