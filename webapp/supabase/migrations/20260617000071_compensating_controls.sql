-- Tier II #13 — Compensating controls + cross-framework mapping.
--
-- Two halves of the same audit-defence story:
--
--   1. compensating_controls    org-owned: "we don't satisfy SOC 2
--                                CC6.1 directly, but here's the
--                                mitigation our auditor accepted."
--
--   2. control_mappings         static (wrapper-owned): a cross-
--                                framework equivalence table that
--                                says SOC 2 CC6.1 ≡ ISO A.8.5 ≡
--                                PCI 8.4 ≡ HIPAA 164.312(a)(2)(i)
--                                ≡ NIST IA-2. Lets us credit one
--                                piece of evidence to five frameworks.
--
-- Why this is the move:
--   Vanta/Drata give you a checklist per framework. They make the
--   user repeat themselves. You answer the same question for SOC 2,
--   then again for ISO, then again for PCI. We're going to surface
--   "this control covers 5 frameworks" and "you accepted this
--   compensating control on 2026-03-12; it's still in effect" as
--   first-class UX.

-- ============================================================================
-- 1. compensating_controls — org-owned overrides
-- ============================================================================

create table if not exists public.compensating_controls (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  framework       text not null,
  control_id      text not null,
  title           text not null check (length(title) between 1 and 200),
  rationale       text not null check (length(rationale) between 1 and 8192),
  -- Free-form evidence links (URLs to internal runbooks, WAF rule
  -- IDs, screenshot paths in your wiki, etc). Surfaces auditor-side.
  evidence_links  text[] not null default array[]::text[],
  effective_from  timestamptz not null default now(),
  -- Optional expiry — most compensating controls are reviewed
  -- annually. UI surfaces an amber "review due" chip 30 days before.
  expires_at      timestamptz,
  created_by      uuid not null references auth.users on delete cascade,
  created_at      timestamptz not null default now(),
  -- Soft delete preserves the audit trail; auditors expect to see
  -- "this was accepted on D1, revoked on D2 because of reason R."
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users on delete set null,
  revocation_reason text
);

create index if not exists compensating_controls_org_framework
  on public.compensating_controls (org_id, framework, control_id)
  where revoked_at is null;

create index if not exists compensating_controls_org_active
  on public.compensating_controls (org_id, effective_from desc)
  where revoked_at is null;

comment on table public.compensating_controls is
  'Tier II #13 — org-declared compensating measures for failing controls. '
  'Auditor-visible; surfaces on the trust page next to the failing control '
  'with an amber "compensated" badge.';

alter table public.compensating_controls enable row level security;

drop policy if exists compensating_controls_org_read on public.compensating_controls;
create policy compensating_controls_org_read on public.compensating_controls
  for select using (org_id = public.current_org_id());

drop policy if exists compensating_controls_org_insert on public.compensating_controls;
create policy compensating_controls_org_insert on public.compensating_controls
  for insert with check (
    org_id = public.current_org_id()
    and created_by = auth.uid()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'member')
    )
  );

drop policy if exists compensating_controls_org_update on public.compensating_controls;
create policy compensating_controls_org_update on public.compensating_controls
  for update using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'member')
    )
  );

-- ============================================================================
-- 2. control_mappings — static cross-framework equivalences
-- ============================================================================

create table if not exists public.control_mappings (
  id         uuid primary key default gen_random_uuid(),
  -- Logical group — all rows with the same `group_key` are equivalent.
  -- e.g. group_key='mfa_enforcement' → soc2:CC6.1 ≡ iso:A.8.5 ≡ pci:8.4
  group_key  text not null,
  group_name text not null,
  framework  text not null,
  control_id text not null,
  -- Brief per-framework note so the UI can show "ISO calls this 'A.8.5
  -- — secure authentication'" inline with the mapping.
  control_label text,
  unique (framework, control_id)
);

create index if not exists control_mappings_group on public.control_mappings (group_key);

comment on table public.control_mappings is
  'Tier II #13 — static cross-framework equivalence table. Wrapper-owned; '
  'updated as auditors publish new cross-reference matrices. One piece of '
  'evidence credits every framework that shares a group_key.';

-- Seed the 25 most-cited cross-framework controls. The list is biased
-- toward what auditors actually grade — auth, access, encryption,
-- logging, vuln management, incident response — rather than trying to
-- be exhaustive. Adding more is a follow-up data PR.

insert into public.control_mappings (group_key, group_name, framework, control_id, control_label)
values
  -- 1. MFA / strong authentication
  ('mfa_enforcement', 'MFA / strong authentication', 'soc_2',       'CC6.1',           'Logical access security'),
  ('mfa_enforcement', 'MFA / strong authentication', 'iso_27001',   'A.8.5',           'Secure authentication'),
  ('mfa_enforcement', 'MFA / strong authentication', 'pci_dss',     '8.4',             'MFA for all access to CDE'),
  ('mfa_enforcement', 'MFA / strong authentication', 'hipaa',       '164.312(a)(2)(i)','Unique user identification'),
  ('mfa_enforcement', 'MFA / strong authentication', 'nist_800_53', 'IA-2',            'Identification and authentication'),

  -- 2. Access review / least privilege
  ('access_review', 'Access review / least privilege', 'soc_2',       'CC6.2',          'Logical access provisioning'),
  ('access_review', 'Access review / least privilege', 'iso_27001',   'A.5.18',         'Access rights review'),
  ('access_review', 'Access review / least privilege', 'pci_dss',     '7.2',            'Restrict access by need-to-know'),
  ('access_review', 'Access review / least privilege', 'hipaa',       '164.308(a)(4)',  'Information access management'),
  ('access_review', 'Access review / least privilege', 'nist_800_53', 'AC-2',           'Account management'),

  -- 3. Privileged access
  ('privileged_access', 'Privileged access controls', 'soc_2',       'CC6.3',          'Authorisation of user privileges'),
  ('privileged_access', 'Privileged access controls', 'iso_27001',   'A.8.2',          'Privileged access rights'),
  ('privileged_access', 'Privileged access controls', 'pci_dss',     '7.1',            'Restrict access to system components'),
  ('privileged_access', 'Privileged access controls', 'nist_800_53', 'AC-6',           'Least privilege'),

  -- 4. Encryption in transit
  ('encryption_in_transit', 'Encryption in transit', 'soc_2',       'CC6.7',           'Restriction of data transmission'),
  ('encryption_in_transit', 'Encryption in transit', 'iso_27001',   'A.8.24',          'Use of cryptography'),
  ('encryption_in_transit', 'Encryption in transit', 'pci_dss',     '4.1',             'Strong cryptography on transmission'),
  ('encryption_in_transit', 'Encryption in transit', 'hipaa',       '164.312(e)(1)',   'Transmission security'),
  ('encryption_in_transit', 'Encryption in transit', 'nist_800_53', 'SC-8',            'Transmission confidentiality'),

  -- 5. Encryption at rest
  ('encryption_at_rest', 'Encryption at rest', 'soc_2',       'CC6.7',           'Data-at-rest encryption'),
  ('encryption_at_rest', 'Encryption at rest', 'iso_27001',   'A.8.24',          'Use of cryptography'),
  ('encryption_at_rest', 'Encryption at rest', 'pci_dss',     '3.4',             'Render PAN unreadable at rest'),
  ('encryption_at_rest', 'Encryption at rest', 'hipaa',       '164.312(a)(2)(iv)','Encryption and decryption'),
  ('encryption_at_rest', 'Encryption at rest', 'nist_800_53', 'SC-28',           'Protection of information at rest'),

  -- 6. Audit logging
  ('audit_logging', 'Audit logging', 'soc_2',       'CC7.2',           'Anomaly identification and reporting'),
  ('audit_logging', 'Audit logging', 'iso_27001',   'A.8.15',          'Logging'),
  ('audit_logging', 'Audit logging', 'pci_dss',     '10.2',            'Audit trails for system events'),
  ('audit_logging', 'Audit logging', 'hipaa',       '164.312(b)',      'Audit controls'),
  ('audit_logging', 'Audit logging', 'nist_800_53', 'AU-2',            'Event logging'),

  -- 7. Log review
  ('log_review', 'Log review & monitoring', 'soc_2',       'CC7.3',                  'Security event monitoring'),
  ('log_review', 'Log review & monitoring', 'iso_27001',   'A.8.16',                 'Monitoring activities'),
  ('log_review', 'Log review & monitoring', 'pci_dss',     '10.4',                   'Review of logs'),
  ('log_review', 'Log review & monitoring', 'hipaa',       '164.308(a)(1)(ii)(D)',   'Information system activity review'),
  ('log_review', 'Log review & monitoring', 'nist_800_53', 'AU-6',                   'Audit record review, analysis, and reporting'),

  -- 8. Vulnerability management
  ('vuln_management', 'Vulnerability management', 'soc_2',       'CC7.1',           'System monitoring for known vulns'),
  ('vuln_management', 'Vulnerability management', 'iso_27001',   'A.8.8',           'Management of technical vulnerabilities'),
  ('vuln_management', 'Vulnerability management', 'pci_dss',     '6.1',             'Establish vuln management process'),
  ('vuln_management', 'Vulnerability management', 'hipaa',       '164.308(a)(8)',   'Evaluation'),
  ('vuln_management', 'Vulnerability management', 'nist_800_53', 'RA-5',            'Vulnerability monitoring and scanning'),

  -- 9. Patch management
  ('patch_management', 'Patch management', 'iso_27001',   'A.8.32',          'Change management'),
  ('patch_management', 'Patch management', 'pci_dss',     '6.2',             'Patch critical security updates'),
  ('patch_management', 'Patch management', 'nist_800_53', 'SI-2',            'Flaw remediation'),

  -- 10. Secure SDLC
  ('secure_sdlc', 'Secure SDLC', 'soc_2',       'CC8.1',           'Change management & dev controls'),
  ('secure_sdlc', 'Secure SDLC', 'iso_27001',   'A.8.25',          'Secure development lifecycle'),
  ('secure_sdlc', 'Secure SDLC', 'pci_dss',     '6.5',             'Address common coding vulnerabilities'),
  ('secure_sdlc', 'Secure SDLC', 'nist_800_53', 'SA-3',            'System development life cycle'),

  -- 11. Incident response
  ('incident_response', 'Incident response', 'soc_2',       'CC7.4',           'Identification and response to incidents'),
  ('incident_response', 'Incident response', 'iso_27001',   'A.5.24',          'Incident management planning'),
  ('incident_response', 'Incident response', 'pci_dss',     '12.10',           'Incident response plan'),
  ('incident_response', 'Incident response', 'hipaa',       '164.308(a)(6)',   'Security incident procedures'),
  ('incident_response', 'Incident response', 'nist_800_53', 'IR-1',            'Incident response policy and procedures'),

  -- 12. Backup & recovery
  ('backup_recovery', 'Backup & recovery', 'soc_2',       'A1.2',                 'Recovery from disruptions'),
  ('backup_recovery', 'Backup & recovery', 'iso_27001',   'A.8.13',               'Information backup'),
  ('backup_recovery', 'Backup & recovery', 'hipaa',       '164.308(a)(7)(ii)(A)', 'Data backup plan'),
  ('backup_recovery', 'Backup & recovery', 'nist_800_53', 'CP-9',                 'System backup'),

  -- 13. Anti-malware
  ('anti_malware', 'Anti-malware / endpoint protection', 'iso_27001',   'A.8.7',           'Protection against malware'),
  ('anti_malware', 'Anti-malware / endpoint protection', 'pci_dss',     '5.1',             'Deploy anti-virus / anti-malware'),
  ('anti_malware', 'Anti-malware / endpoint protection', 'hipaa',       '164.308(a)(5)',   'Security awareness and training'),
  ('anti_malware', 'Anti-malware / endpoint protection', 'nist_800_53', 'SI-3',            'Malicious code protection'),

  -- 14. Configuration management / hardening
  ('config_management', 'Configuration management', 'soc_2',       'CC7.1',           'Configuration monitoring'),
  ('config_management', 'Configuration management', 'iso_27001',   'A.8.9',           'Configuration management'),
  ('config_management', 'Configuration management', 'pci_dss',     '2.2',             'Apply secure configurations'),
  ('config_management', 'Configuration management', 'nist_800_53', 'CM-2',            'Baseline configuration'),

  -- 15. Change management
  ('change_management', 'Change management', 'soc_2',       'CC8.1',           'Authorize, design, develop, configure'),
  ('change_management', 'Change management', 'iso_27001',   'A.8.32',          'Change management'),
  ('change_management', 'Change management', 'pci_dss',     '6.4',             'Change management procedures'),
  ('change_management', 'Change management', 'nist_800_53', 'CM-3',            'Configuration change control'),

  -- 16. Vendor / third-party risk
  ('vendor_risk', 'Vendor / third-party risk', 'soc_2',       'CC9.2',           'Vendor risk management'),
  ('vendor_risk', 'Vendor / third-party risk', 'iso_27001',   'A.5.19',          'Supplier relationships'),
  ('vendor_risk', 'Vendor / third-party risk', 'pci_dss',     '12.8',            'Service provider management'),
  ('vendor_risk', 'Vendor / third-party risk', 'hipaa',       '164.308(b)',      'Business associate contracts'),
  ('vendor_risk', 'Vendor / third-party risk', 'nist_800_53', 'SA-9',            'External system services'),

  -- 17. Password policy
  ('password_policy', 'Password policy', 'iso_27001',   'A.8.5',           'Secure authentication'),
  ('password_policy', 'Password policy', 'pci_dss',     '8.3',             'Strong password requirements'),
  ('password_policy', 'Password policy', 'nist_800_53', 'IA-5',            'Authenticator management'),

  -- 18. Session management
  ('session_management', 'Session management', 'pci_dss',     '8.1',             'Session timeouts'),
  ('session_management', 'Session management', 'hipaa',       '164.312(a)(2)(iii)','Automatic logoff'),
  ('session_management', 'Session management', 'nist_800_53', 'AC-12',           'Session termination'),

  -- 19. Data classification
  ('data_classification', 'Data classification', 'soc_2',       'CC3.2',           'Risk identification'),
  ('data_classification', 'Data classification', 'iso_27001',   'A.5.12',          'Classification of information'),
  ('data_classification', 'Data classification', 'pci_dss',     '9.6',             'Media classification'),
  ('data_classification', 'Data classification', 'nist_800_53', 'RA-2',            'Security categorization'),

  -- 20. Network segmentation
  ('network_segmentation', 'Network segmentation', 'iso_27001',   'A.8.22',          'Segregation of networks'),
  ('network_segmentation', 'Network segmentation', 'pci_dss',     '1.2',             'Build firewall configurations'),
  ('network_segmentation', 'Network segmentation', 'nist_800_53', 'SC-7',            'Boundary protection'),

  -- 21. Security awareness training
  ('security_training', 'Security awareness training', 'soc_2',       'CC2.2',                'Internal communication'),
  ('security_training', 'Security awareness training', 'iso_27001',   'A.6.3',                'Information security awareness'),
  ('security_training', 'Security awareness training', 'pci_dss',     '12.6',                 'Security awareness program'),
  ('security_training', 'Security awareness training', 'hipaa',       '164.308(a)(5)(i)',     'Security awareness and training'),
  ('security_training', 'Security awareness training', 'nist_800_53', 'AT-2',                 'Awareness training'),

  -- 22. Risk assessment
  ('risk_assessment', 'Risk assessment', 'soc_2',       'CC3.1',                'Risk identification process'),
  ('risk_assessment', 'Risk assessment', 'iso_27001',   'A.5.5',                'Contact with authorities'),
  ('risk_assessment', 'Risk assessment', 'pci_dss',     '12.2',                 'Risk assessment process'),
  ('risk_assessment', 'Risk assessment', 'hipaa',       '164.308(a)(1)(ii)(A)', 'Risk analysis'),
  ('risk_assessment', 'Risk assessment', 'nist_800_53', 'RA-3',                 'Risk assessment'),

  -- 23. Physical access
  ('physical_access', 'Physical access', 'soc_2',       'CC6.4',           'Physical access security'),
  ('physical_access', 'Physical access', 'iso_27001',   'A.7.2',           'Physical entry controls'),
  ('physical_access', 'Physical access', 'pci_dss',     '9.1',             'Limit physical access'),
  ('physical_access', 'Physical access', 'hipaa',       '164.310(a)(1)',   'Facility access controls'),
  ('physical_access', 'Physical access', 'nist_800_53', 'PE-2',            'Physical access authorizations'),

  -- 24. Penetration testing
  ('pen_testing', 'Penetration testing', 'iso_27001',   'A.8.29',          'Security testing in development'),
  ('pen_testing', 'Penetration testing', 'pci_dss',     '11.3',            'External and internal pen tests'),
  ('pen_testing', 'Penetration testing', 'nist_800_53', 'CA-8',            'Penetration testing'),

  -- 25. Information security policy
  ('isms_policy', 'Information security policy', 'iso_27001',   'A.5.1',           'Policies for information security'),
  ('isms_policy', 'Information security policy', 'pci_dss',     '12.1',            'Establish security policy'),
  ('isms_policy', 'Information security policy', 'hipaa',       '164.316(a)',      'Policies and procedures'),
  ('isms_policy', 'Information security policy', 'nist_800_53', 'PL-1',            'Security planning policy')
on conflict (framework, control_id) do nothing;

-- ============================================================================
-- 3. RPCs
-- ============================================================================

-- equivalent_controls(framework, control_id) — anon-safe lookup so the
-- engine, the trust page, and external integrators (MCP tools) can all
-- read the same mapping without a JWT.

drop function if exists public.equivalent_controls(text, text);

create or replace function public.equivalent_controls(
  p_framework  text,
  p_control_id text
)
returns table (
  group_key     text,
  group_name    text,
  framework     text,
  control_id    text,
  control_label text
)
language sql
security invoker
set search_path = public
stable
as $$
  with origin as (
    select cm.group_key
      from public.control_mappings cm
     where cm.framework  = p_framework
       and cm.control_id = p_control_id
     limit 1
  )
  select cm.group_key,
         cm.group_name,
         cm.framework,
         cm.control_id,
         cm.control_label
    from public.control_mappings cm
    join origin o on o.group_key = cm.group_key
   order by cm.framework, cm.control_id;
$$;

grant execute on function public.equivalent_controls(text, text) to anon, authenticated;

comment on function public.equivalent_controls(text, text) is
  'Tier II #13 — given (framework, control_id), return every '
  'equivalent control across other frameworks. Powers the "this also '
  'covers SOC 2 CC6.1 and PCI 8.4" UX next to a finding.';

-- compensating_controls_active(org, framework) — RLS-friendly list
-- filtered to non-revoked, non-expired entries.

drop function if exists public.compensating_controls_active(text);

create or replace function public.compensating_controls_active(
  p_framework text default null
)
returns table (
  id              uuid,
  framework       text,
  control_id      text,
  title           text,
  rationale       text,
  evidence_links  text[],
  effective_from  timestamptz,
  expires_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz,
  -- True when expires_at is within 30 days. UI shows an amber
  -- "review due soon" chip on the row.
  review_due_soon boolean
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    cc.id,
    cc.framework,
    cc.control_id,
    cc.title,
    cc.rationale,
    cc.evidence_links,
    cc.effective_from,
    cc.expires_at,
    cc.created_by,
    cc.created_at,
    (cc.expires_at is not null and cc.expires_at < now() + interval '30 days') as review_due_soon
  from public.compensating_controls cc
  where cc.org_id = public.current_org_id()
    and cc.revoked_at is null
    and (cc.expires_at is null or cc.expires_at > now())
    and (p_framework is null or cc.framework = p_framework)
  order by cc.effective_from desc;
$$;

grant execute on function public.compensating_controls_active(text) to authenticated;

-- compensating_controls_for_trust(slug) — anon-safe, surfaces only
-- active rows for an org that has opted into the public trust page.
-- The auditor visiting the trust page should see "yes, they accept
-- responsibility for this gap via control X" with the rationale,
-- but not the internal evidence_links (which often contain internal
-- runbook URLs). We strip evidence_links in the public projection.

drop function if exists public.compensating_controls_for_trust(text);

create or replace function public.compensating_controls_for_trust(p_slug text)
returns table (
  framework        text,
  control_id       text,
  title            text,
  -- Truncated rationale: first 280 chars + "…" if longer. Public-
  -- facing surface; the full text stays internal.
  rationale_excerpt text,
  effective_from   timestamptz,
  expires_at       timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_org_id uuid;
  v_enabled boolean;
begin
  select id, coalesce(trust_page_enabled, false)
    into v_org_id, v_enabled
    from public.organizations
   where slug = p_slug;

  if v_org_id is null or v_enabled is not true then
    return;
  end if;

  return query
    select
      cc.framework,
      cc.control_id,
      cc.title,
      case
        when length(cc.rationale) <= 280 then cc.rationale
        else substring(cc.rationale from 1 for 279) || '…'
      end as rationale_excerpt,
      cc.effective_from,
      cc.expires_at
    from public.compensating_controls cc
    where cc.org_id = v_org_id
      and cc.revoked_at is null
      and (cc.expires_at is null or cc.expires_at > now())
    order by cc.framework, cc.control_id;
end;
$$;

revoke execute on function public.compensating_controls_for_trust(text) from public;
grant   execute on function public.compensating_controls_for_trust(text) to anon, authenticated;

comment on function public.compensating_controls_for_trust(text) is
  'Tier II #13 — anon-safe projection of active compensating controls '
  'for the public trust page. Strips evidence_links and truncates '
  'rationale to 280 chars.';
