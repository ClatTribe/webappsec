-- Compliance remediation templates — AISecurityEngineerUXRoadmap.md §5.
--
-- The vibe-coded founder asks in chat: "how do I close CC7.2?"
-- TensorShield should answer with 2-3 concrete options ranked by
-- effort + trust trade-off, the way a senior compliance engineer
-- would. The roadmap §5 promised:
--
--   option 1: configure Vercel log drain to a SIEM…  2-3 hours
--   option 2: Supabase audit log + Cloudflare logpush  4 hours
--   option 3: skip — but disclose to your auditor    0 hours, low trust
--
-- v1 ships hand-curated options for the most-failing SOC 2 controls
-- (CC7.2 SIEM, CC7.3 IR plan, A1.2 backups, CC8.2 PR review, P1.1
-- privacy notice). v2 will let the chat agent generate ad-hoc options
-- via LLM for controls without templates.

create table if not exists public.compliance_remediation_templates (
  id              uuid primary key default gen_random_uuid(),
  framework       text not null,           -- 'soc2_type_2'
  control_id      text not null,           -- 'CC7.2'
  option_position int  not null,           -- 1 = best-trust, 2 = compromise, 3 = skip-with-disclosure
  option_title    text not null,           -- 'Configure log drain to a SIEM'
  option_body_md  text not null,           -- markdown with steps + considerations
  effort_hours    int,                     -- nullable; null means "varies"
  trust_impact    text not null check (trust_impact in ('high','medium','low','negative')),
  created_at      timestamptz not null default now(),
  unique (framework, control_id, option_position)
);

create index if not exists compliance_remediation_lookup
  on public.compliance_remediation_templates (framework, control_id, option_position);

comment on table public.compliance_remediation_templates is
  'Hand-curated remediation options the chat agent surfaces when the '
  'founder asks "how do I close <control_id>?". Read-only catalog.';

alter table public.compliance_remediation_templates enable row level security;

drop policy if exists compliance_remediation_public_read on public.compliance_remediation_templates;
create policy compliance_remediation_public_read on public.compliance_remediation_templates
  for select to authenticated, anon
  using (true);

-- ============== SEED ==============
-- Five high-frequency SOC 2 failures with concrete options.

insert into public.compliance_remediation_templates
  (framework, control_id, option_position, option_title, option_body_md, effort_hours, trust_impact)
values

  ('soc2_type_2', 'CC7.2', 1,
   'Ship logs to a SIEM (Datadog / Sumo / Splunk)',
   E'**Steps**\n\n1. Configure a log drain from your hosting provider (Vercel / Render / Fly) to your SIEM of choice.\n2. Enable Supabase audit log retention (settings → API → Logs).\n3. Set 90-day retention on the SIEM side; alerting on auth-failures + admin-actions.\n\n**Evidence for the auditor**\n- Screenshot of log drain config\n- Sample retention query\n- Alerting rule list\n\n**Why this is the high-trust option**\nAuditors want continuous monitoring with retention. SIEM ticks both boxes and gives you incident-response data when you need it.',
   3, 'high'),

  ('soc2_type_2', 'CC7.2', 2,
   'Self-host logs in S3 / Cloudflare R2',
   E'**Steps**\n\n1. Cron-export Supabase logs to S3 weekly via pg_dump or supabase API.\n2. Cloudfront / Vercel logs → S3 via log-drain.\n3. Bucket lifecycle policy: 90-day retention, IA after 30 days.\n\n**Evidence for the auditor**\n- IaC for the S3 buckets + lifecycle\n- Sample log file showing required event fields\n\n**Why mid-trust**\nMeets the literal control. Less queryable than a SIEM during an incident. Acceptable for early-stage SOC 2; you''ll likely upgrade to a SIEM by Type 2.',
   4, 'medium'),

  ('soc2_type_2', 'CC7.2', 3,
   'Disclose the gap with a target date',
   E'**Steps**\n\n1. Add a compensating control note to your SAQ: "Log aggregation is being implemented; target Q[next] for SIEM deployment."\n2. Commit to a deadline. Most auditors accept this for a Type 1.\n\n**Why this is here**\nIf you''re 3 weeks from your audit, sometimes the honest answer is "we don''t have this yet but here''s our plan". Auditors prefer disclosure over fabricated evidence.\n\n**Trust cost**\nMaterial. The auditor''s opinion may include this as a finding.',
   0, 'negative'),

  ('soc2_type_2', 'CC7.3', 1,
   'Write a 2-page incident response plan + run a tabletop',
   E'**Steps**\n\n1. Adapt a template (PagerDuty IR Guide / SANS IR template — both free).\n2. Define roles: IR lead, comms lead, technical lead.\n3. Run one tabletop exercise (60 min). Document with screenshots.\n4. Annual review reminder on your calendar.\n\n**Evidence**\n- The IR plan PDF\n- Tabletop minutes\n- Calendar reminder for annual review',
   4, 'high'),

  ('soc2_type_2', 'CC7.3', 2,
   'Reference an industry standard (NIST 800-61 / SANS)',
   E'**Steps**\n\n1. Adopt NIST 800-61 by reference. Document "We follow NIST 800-61 Rev 2 for incident response."\n2. Map your existing pager / on-call rotation to the 4 NIST phases.\n3. Document role assignments.\n\n**Evidence**\n- One-page mapping doc\n- On-call schedule export\n\n**Trust trade-off**\nLower bar than a custom IR plan but defensible. Suitable for orgs <20 people.',
   2, 'medium'),

  ('soc2_type_2', 'A1.2', 1,
   'Daily encrypted DB backups + monthly restore test',
   E'**Steps**\n\n1. Supabase: enable daily backups (Database → Backups → Enable).\n2. Configure cross-region replication if available on your plan.\n3. Calendar reminder for monthly restore test → ephemeral DB → run smoke tests against it.\n4. Document the restore procedure in a runbook.\n\n**Evidence**\n- Backup config screenshot\n- Restore-test log (3 most recent)\n- Runbook URL',
   2, 'high'),

  ('soc2_type_2', 'A1.2', 2,
   'Application-level snapshots to S3 (no live restore test)',
   E'**Steps**\n\n1. Cron job dumps DB nightly to encrypted S3.\n2. Lifecycle: 30-day retention.\n3. Document but skip the monthly restore test.\n\n**Trust trade-off**\nWorks for Type 1. Type 2 auditors usually ask for evidence of a successful restore.',
   1, 'medium'),

  ('soc2_type_2', 'CC8.2', 1,
   'Require PR review + branch protection',
   E'**Steps**\n\n1. GitHub: Settings → Branches → Protect main → require 1 reviewer.\n2. Enable status checks (CI must pass).\n3. Block force-push and direct commits to main.\n4. (Optional) Require signed commits.\n\n**Evidence**\n- Branch protection screenshot\n- Sample PR showing reviewer approval before merge',
   1, 'high'),

  ('soc2_type_2', 'P1.1', 1,
   'Publish a privacy policy + cookie banner',
   E'**Steps**\n\n1. Generate a baseline policy with Termly / iubenda / write your own.\n2. Cover: what data you collect, retention, third-party processors (TensorShield + Supabase + your LLM provider).\n3. Cookie banner with reject-all (Iubenda / Cookiebot — both have free tiers).\n4. Link from footer + signup flow.\n\n**Evidence**\n- Live URLs\n- Sub-processor list',
   2, 'high'),

  ('soc2_type_2', 'CC6.7', 1,
   'Enforce least-privilege + access-review process',
   E'**Steps**\n\n1. Quarterly access review: export org_members + role list, owner reviews and removes stale grants.\n2. Document the cadence in your IR/Security runbook.\n3. Use RBAC at the cloud-account level too (no shared admin credentials).\n\n**Evidence**\n- Most-recent quarterly review export\n- Sample removal email',
   3, 'high')

on conflict (framework, control_id, option_position) do update set
  option_title   = excluded.option_title,
  option_body_md = excluded.option_body_md,
  effort_hours   = excluded.effort_hours,
  trust_impact   = excluded.trust_impact;

-- ============== LOOKUP RPC ==============

create or replace function public.get_control_remediation(
  p_framework  text,
  p_control_id text
)
returns table (
  option_position int,
  option_title    text,
  option_body_md  text,
  effort_hours    int,
  trust_impact    text
)
language sql
security definer
set search_path = public
stable
as $$
  select option_position, option_title, option_body_md, effort_hours, trust_impact
  from public.compliance_remediation_templates
  where framework  = p_framework
    and control_id = p_control_id
  order by option_position;
$$;

revoke execute on function public.get_control_remediation(text, text) from public;
grant   execute on function public.get_control_remediation(text, text)
  to authenticated, service_role;
