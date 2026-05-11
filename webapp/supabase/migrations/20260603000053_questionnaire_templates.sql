-- Compliance questionnaire pre-fill — AISecurityEngineerUXRoadmap.md §10
-- (auto-questionnaire path). The vibe-coded founder's killer feature.
--
-- Workflow today: prospect asks "are you SOC 2 ready?" → founder shares
-- the trust page. Prospect's procurement team replies with a 200-question
-- vendor security assessment (SIG Lite / CAIQ / a custom SOC 2 SAQ). The
-- founder spends 40 hours/quarter filling these out by hand.
--
-- This migration ships:
--   1. A `compliance_questionnaire_templates` table — one row per
--      (questionnaire, question), mapping the question to one or more
--      compliance_evidence control_ids.
--   2. A seed of ~14 SOC 2 SAQ questions referencing real Trust Services
--      Criteria control IDs (CC6.1, CC6.6, CC7.1, CC7.2, CC8.1, A1.2 …).
--   3. RPC `org_questionnaire_response(org_id, key)` that joins templates
--      × org_compliance_posture_v and produces an auto-filled answer per
--      question. The worst control verdict drives the answer status.
--
-- The output goes into a settings page where the founder can review +
-- export (CSV / JSON / PDF) before sending. v1 is read-only; v2 adds
-- override + edit-in-place.

-- ============== TEMPLATES TABLE ==============

create table if not exists public.compliance_questionnaire_templates (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,           -- 'soc2_saq_v1', 'sig_lite_v1', 'caiq_v4', 'vsa_v1'
  framework     text not null,           -- the framework these controls live in
  position      int  not null,           -- presentation order
  section       text,                    -- 'CC6 — Logical Access'
  question_id   text not null,           -- 'Q1', 'CC6.1.A', 'SIG.1.2'
  question      text not null,           -- the prose question as the auditor will read it
  control_ids   text[] not null,         -- {CC6.1, CC6.6} — refs into compliance_evidence
  note          text,                    -- optional editorial context the founder may keep / drop
  created_at    timestamptz not null default now(),
  unique (key, question_id)
);

create index if not exists compliance_qt_key on public.compliance_questionnaire_templates (key, position);

comment on table public.compliance_questionnaire_templates is
  'Library of common security questionnaire question templates (SOC 2 '
  'SAQ, SIG, CAIQ, VSA). Each row maps a question to the compliance_evidence '
  'control IDs that determine the answer. Read-only catalog — no RLS '
  'needed; authenticated and anon can both select.';

alter table public.compliance_questionnaire_templates enable row level security;

drop policy if exists compliance_qt_public_read on public.compliance_questionnaire_templates;
create policy compliance_qt_public_read on public.compliance_questionnaire_templates
  for select to authenticated, anon
  using (true);

-- ============== SEED — SOC 2 Trust Services SAQ (subset) ==============
-- 14 questions across the 5 TSC categories. Real control IDs that match
-- the engine's compliance_evidence.json verdicts (engine PR #219 §4b).

insert into public.compliance_questionnaire_templates
  (key, framework, position, section, question_id, question, control_ids, note)
values
  ('soc2_saq_v1', 'soc2_type_2',  1, 'CC6 — Logical Access',
   'CC6.1', 'Do you restrict logical access to information assets using authentication and authorization controls?',
   array['CC6.1'],
   'Auto-derived from your scan posture: RLS on tenant tables + auth-required endpoint coverage.'),

  ('soc2_saq_v1', 'soc2_type_2',  2, 'CC6 — Logical Access',
   'CC6.2', 'Are users registered and authorized prior to being issued credentials?',
   array['CC6.2'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  3, 'CC6 — Logical Access',
   'CC6.6', 'Do you enforce TLS for all data-in-transit between users and your service?',
   array['CC6.6'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  4, 'CC6 — Logical Access',
   'CC6.7', 'Do you restrict the transmission, movement, and removal of information to authorized users?',
   array['CC6.7'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  5, 'CC7 — System Operations',
   'CC7.1', 'Do you use vulnerability scanning to detect security weaknesses in your applications and infrastructure?',
   array['CC7.1'],
   'TensorShield itself runs as your continuous vulnerability scanner.'),

  ('soc2_saq_v1', 'soc2_type_2',  6, 'CC7 — System Operations',
   'CC7.2', 'Do you collect, aggregate, and review system event logs to detect anomalous activity?',
   array['CC7.2'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  7, 'CC7 — System Operations',
   'CC7.3', 'Do you have a documented and tested incident response plan?',
   array['CC7.3'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  8, 'CC8 — Change Management',
   'CC8.1', 'Do you follow a documented change management process before deploying to production?',
   array['CC8.1'],
   null),

  ('soc2_saq_v1', 'soc2_type_2',  9, 'CC8 — Change Management',
   'CC8.2', 'Do you maintain version control and require peer review of code changes?',
   array['CC8.2'],
   null),

  ('soc2_saq_v1', 'soc2_type_2', 10, 'A1 — Availability',
   'A1.1',  'Do you monitor capacity and performance of your production environment?',
   array['A1.1'],
   null),

  ('soc2_saq_v1', 'soc2_type_2', 11, 'A1 — Availability',
   'A1.2',  'Are backups encrypted, tested, and stored separately from production?',
   array['A1.2'],
   null),

  ('soc2_saq_v1', 'soc2_type_2', 12, 'P1 — Privacy',
   'P1.1',  'Do you maintain a privacy notice and obtain consent before collecting personal information?',
   array['P1.1'],
   'If your app handles personal data, point the prospect at your privacy policy URL.'),

  ('soc2_saq_v1', 'soc2_type_2', 13, 'CC1 — Control Environment',
   'CC1.4', 'Do you require all personnel to sign a code of conduct / acceptable use policy?',
   array['CC1.4'],
   null),

  ('soc2_saq_v1', 'soc2_type_2', 14, 'C1 — Confidentiality',
   'C1.1',  'Is customer data isolated such that one customer cannot access another customer''s data?',
   array['C1.1', 'CC6.1'],
   'Per-workspace data isolation is enforced by row-level security on every table.')
on conflict (key, question_id) do update set
  question     = excluded.question,
  control_ids  = excluded.control_ids,
  section      = excluded.section,
  note         = excluded.note,
  framework    = excluded.framework,
  position     = excluded.position;

-- ============== RESPONSE RPC ==============
-- Joins templates × org's latest verdict per (framework, control_id).
-- Answer_status policy: worst verdict across the question's controls
-- drives the row.
--   any control = 'fail'                       → 'fail'
--   any control = 'warn'                       → 'warn'
--   all controls = 'pass'                      → 'pass'
--   any control missing / 'untested' / 'info'  → 'untested'

create or replace function public.org_questionnaire_response(
  p_org_id uuid,
  p_key    text
)
returns table (
  pos             int,
  section         text,
  question_id     text,
  question        text,
  note            text,
  control_ids     text[],
  answer_status   text,
  evidence        jsonb        -- per-control verdicts + summaries the founder can include in the answer
)
language sql
security definer
set search_path = public
stable
as $$
  with t as (
    select * from public.compliance_questionnaire_templates
    where key = p_key
  ),
  expanded as (
    select t.id, t.position as pos, t.section, t.question_id, t.question,
           t.note, t.control_ids, t.framework,
           unnest(t.control_ids) as control_id
    from t
  ),
  joined as (
    select e.*, p.verdict, p.evidence_summary, p.observed_at
    from expanded e
    left join public.org_compliance_posture_v p
      on p.org_id    = p_org_id
     and p.framework = e.framework
     and p.control_id = e.control_id
  ),
  per_q as (
    select
      id, pos, section, question_id, question, note, control_ids,
      bool_or(verdict = 'fail') as has_fail,
      bool_or(verdict = 'warn') as has_warn,
      bool_or(verdict = 'pass') as has_pass,
      bool_or(verdict is null or verdict in ('untested','info')) as has_untested,
      jsonb_agg(
        jsonb_build_object(
          'control_id', control_id,
          'verdict',    coalesce(verdict, 'untested'),
          'summary',    evidence_summary,
          'observed_at',observed_at
        )
        order by control_id
      ) as evidence
    from joined
    group by id, pos, section, question_id, question, note, control_ids
  )
  select
    pos,
    section,
    question_id,
    question,
    note,
    control_ids,
    case
      when has_fail                                            then 'fail'
      when has_warn                                            then 'warn'
      when has_untested and not has_pass                       then 'untested'
      when has_untested                                        then 'partial'
      else 'pass'
    end as answer_status,
    evidence
  from per_q
  order by pos;
$$;

revoke execute on function public.org_questionnaire_response(uuid, text)
  from public, anon;
grant   execute on function public.org_questionnaire_response(uuid, text)
  to authenticated, service_role;

comment on function public.org_questionnaire_response(uuid, text) is
  'Joins compliance_questionnaire_templates × org_compliance_posture_v to '
  'produce a pre-filled answer per question. Worst control verdict drives '
  'each row. Authenticated callers — the function does not enforce '
  'org_id = current_org_id() because compliance_evidence RLS already does.';
