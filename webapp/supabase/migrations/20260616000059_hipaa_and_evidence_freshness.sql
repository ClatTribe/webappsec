-- Tier C: HIPAA Security Rule support + auditor-grade evidence freshness.
--
-- Two related additions that compose into "the trust page now answers
-- 'how stale is your evidence?' across every framework, and HIPAA is a
-- first-class framework alongside SOC 2 / ISO 27001 / PCI":
--
--   1. Seed a HIPAA Security Rule SAQ into compliance_questionnaire_templates
--      (engine PR #253 / wrapper Tier C #5). The HIPAA Security Rule maps
--      cleanly to ~10 high-yield questions across the three safeguard
--      categories (Administrative / Physical / Technical). Each row
--      references a real 45 CFR § 164.30x control id so the engine's
--      compliance_evidence verdicts can drive the answers.
--
--   2. Extend `get_trust_page_payload` to roll up two new freshness
--      signals per framework (engine PR #252 / wrapper Tier C #6):
--        - latest_observed_at — max(observed_at) across the framework's
--          controls. Surfaces as "Latest evidence: N days ago" on the
--          public trust page so prospects + auditors see at-a-glance
--          whether the org is actively scanning.
--        - stale_controls — count of controls whose engine-emitted
--          `expires_at` is now past. Strix's compliance.evidence module
--          stamps `expires_at = evidence_collected_at + STRIX_EVIDENCE_
--          TTL_DAYS` (default 90); the wrapper trusts the engine's
--          authoritative TTL rather than re-deriving locally.
--
-- Both work with whatever the engine emits — no CHECK constraints on
-- detail JSONB, no new tables. Older engines without §252 leave
-- detail->>'expires_at' null and the staleness count cleanly returns 0.

-- ---------------------------------------------------------------------------
-- 1. HIPAA Security Rule SAQ template — 10 questions
-- ---------------------------------------------------------------------------
--
-- Question IDs use the 45 CFR § 164.30x control identifiers the engine's
-- HIPAA compliance module emits. Sections mirror the Security Rule's
-- three safeguard categories.

insert into public.compliance_questionnaire_templates
  (key, framework, position, section, question_id, question, control_ids, note)
values
  ('hipaa_saq_v1', 'hipaa',  1, 'Administrative Safeguards',
   '164.308(a)(1)(ii)(A)',
   'Have you conducted an accurate and thorough risk analysis of vulnerabilities to ePHI?',
   array['164.308(a)(1)(ii)(A)'],
   'TensorShield continuously enumerates application-layer risks across the protected surfaces — that''s your standing risk analysis.'),

  ('hipaa_saq_v1', 'hipaa',  2, 'Administrative Safeguards',
   '164.308(a)(1)(ii)(B)',
   'Do you implement security measures sufficient to reduce risks and vulnerabilities to ePHI to a reasonable and appropriate level?',
   array['164.308(a)(1)(ii)(B)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  3, 'Administrative Safeguards',
   '164.308(a)(3)(ii)(A)',
   'Do you implement procedures for authorising and supervising workforce members who work with ePHI?',
   array['164.308(a)(3)(ii)(A)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  4, 'Administrative Safeguards',
   '164.308(a)(5)(ii)(B)',
   'Do you have security-awareness training that covers protection from malicious software?',
   array['164.308(a)(5)(ii)(B)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  5, 'Administrative Safeguards',
   '164.308(a)(6)(ii)',
   'Do you identify, respond to, and document security incidents and their outcomes?',
   array['164.308(a)(6)(ii)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  6, 'Technical Safeguards',
   '164.312(a)(1)',
   'Do you implement technical policies and procedures that restrict access to ePHI to authorised persons or software?',
   array['164.312(a)(1)'],
   'Driven by your scan posture: RLS-enforced tenant isolation + authenticated-endpoint coverage.'),

  ('hipaa_saq_v1', 'hipaa',  7, 'Technical Safeguards',
   '164.312(a)(2)(iv)',
   'Do you encrypt ePHI at rest where reasonable and appropriate?',
   array['164.312(a)(2)(iv)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  8, 'Technical Safeguards',
   '164.312(b)',
   'Do you implement audit controls — hardware, software, or procedural mechanisms — that record and examine activity in systems containing ePHI?',
   array['164.312(b)'],
   null),

  ('hipaa_saq_v1', 'hipaa',  9, 'Technical Safeguards',
   '164.312(e)(1)',
   'Do you implement technical security measures to guard against unauthorised access to ePHI being transmitted over an electronic communications network?',
   array['164.312(e)(1)'],
   'TLS coverage across externally-reachable endpoints is part of every scan.'),

  ('hipaa_saq_v1', 'hipaa', 10, 'Physical Safeguards',
   '164.310(d)(1)',
   'Do you implement policies and procedures that govern the receipt and removal of hardware and electronic media containing ePHI?',
   array['164.310(d)(1)'],
   'Physical safeguard — out of scope for the automated scan posture; included so the questionnaire export is complete.')
on conflict (key, question_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Trust-page payload: per-framework freshness rollup
-- ---------------------------------------------------------------------------
--
-- The RPC body is large; we replace it in full so the freshness CTE +
-- the framework jsonb_build shape sit together. Two behavioural changes
-- versus the prior version (migration 047):
--
--   * `per_fw` now also computes `latest_observed_at` (max of the
--     framework's controls) + `stale_controls` (count of controls
--     whose `detail->>'expires_at'` is in the past).
--   * The output jsonb gains `latest_observed_at` + `stale_controls`
--     keys per framework. Older clients ignore unknown keys; newer
--     clients render the freshness badge.
--
-- Everything else — slug resolution, stats CTE, recent-resolved CTE,
-- footer attestation — is byte-identical to the original.

create or replace function public.get_trust_page_payload(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_org    record;
  v_postures jsonb;
  v_stats    jsonb;
  v_recent_resolved jsonb;
begin
  select
    o.id, o.name, o.slug, o.plan,
    o.trust_page_enabled,
    o.trust_page_subtitle,
    o.trust_page_published_at,
    o.created_at
  into v_org
  from public.organizations o
  where o.slug = p_slug
    and o.trust_page_enabled = true
  limit 1;

  if v_org.id is null then
    return null;
  end if;

  -- per_fw: framework-level rollup over org_compliance_posture_v (the
  -- latest-verdict-per-control view). `expires_at` is read directly out
  -- of the detail JSONB the engine emits — strix/compliance/evidence.py
  -- stamps it as `evidence_collected_at + STRIX_EVIDENCE_TTL_DAYS`
  -- (default 90). When absent (older engine), the staleness condition
  -- short-circuits and stale_controls stays 0 for that framework.
  with per_fw as (
    select
      framework,
      count(*) filter (where verdict = 'pass')::int                        as passing,
      count(*) filter (where verdict = 'fail')::int                        as failing,
      count(*) filter (where verdict = 'warn')::int                        as warning,
      count(*) filter (where verdict in ('untested','info'))::int          as untested,
      count(*)::int                                                        as total,
      max(observed_at)                                                     as latest_observed_at,
      count(*) filter (
        where (detail->>'expires_at') is not null
          and (detail->>'expires_at')::timestamptz < now()
      )::int                                                               as stale_controls
    from public.org_compliance_posture_v
    where org_id = v_org.id
    group by framework
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'framework',          framework,
      'total',              total,
      'passing',            passing,
      'failing',            failing,
      'warning',            warning,
      'untested',           untested,
      'readiness_pct',
        case when total - untested = 0 then 0
        else round(100.0 * passing / nullif(total - untested, 0), 1) end,
      'latest_observed_at', latest_observed_at,
      'stale_controls',     stale_controls
    )
    order by framework
  ), '[]'::jsonb)
  into v_postures
  from per_fw;

  with recent as (
    select status, severity from public.findings
    where org_id = v_org.id
      and last_seen_at >= now() - interval '30 days'
  )
  select jsonb_build_object(
    'window_days',        30,
    'open_critical',      (select count(*) from recent where status='open' and severity='critical'),
    'open_high',          (select count(*) from recent where status='open' and severity='high'),
    'fixed_last_30d',     (select count(*) from recent where status='fixed'),
    'dismissed_last_30d', (select count(*) from recent where status in ('false_positive','dismissed_by_ai','wont_fix')),
    'total_last_30d',     (select count(*) from recent)
  )
  into v_stats;

  with recent_resolved as (
    select
      f.title,
      f.severity,
      coalesce(f.triaged_at, f.last_seen_at) as resolved_at,
      f.status
    from public.findings f
    where f.org_id = v_org.id
      and f.status in ('fixed','false_positive','dismissed_by_ai','wont_fix')
      and coalesce(f.triaged_at, f.last_seen_at) >= now() - interval '30 days'
    order by resolved_at desc
    limit 5
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'title',       title,
      'severity',    severity,
      'resolved_at', resolved_at,
      'status',      status
    )
    order by resolved_at desc
  ), '[]'::jsonb)
  into v_recent_resolved
  from recent_resolved;

  return jsonb_build_object(
    'org', jsonb_build_object(
      'name',              v_org.name,
      'slug',              v_org.slug,
      'subtitle',          v_org.trust_page_subtitle,
      'plan',              v_org.plan,
      'published_at',      v_org.trust_page_published_at,
      'monitoring_since',  v_org.created_at
    ),
    'frameworks',      v_postures,
    'stats',           v_stats,
    'recent_resolved', v_recent_resolved,
    'generated_at',    now()
  );
end;
$$;

grant execute on function public.get_trust_page_payload(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. org_questionnaire_response — surface engine freshness fields
-- ---------------------------------------------------------------------------
--
-- The per-question evidence jsonb gains two engine-emitted fields so the
-- questionnaire-export view can show "evidence is N days old / stale" next
-- to each control. They're pulled out of compliance_evidence.detail —
-- strix/compliance/evidence.py stamps both at scan time. Older engines
-- emit nothing here and the wrapper-side render gracefully hides the
-- chip (see questionnaire-client.tsx `describeFreshness`).
--
-- Replacing the function in full matches the migration-053 pattern: the
-- body is small enough to read at one glance, and we don't risk
-- desync between the legacy and freshness-augmented shapes by trying
-- to patch in place.

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
  evidence        jsonb
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
    select e.*, p.verdict, p.evidence_summary, p.observed_at, p.detail
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
          'control_id',            control_id,
          'verdict',               coalesce(verdict, 'untested'),
          'summary',               evidence_summary,
          'observed_at',           observed_at,
          -- Engine freshness fields (strix PR #252). Both are nullable
          -- — older engine versions don't populate them and the
          -- frontend handles that case.
          'evidence_collected_at', detail->>'evidence_collected_at',
          'expires_at',            detail->>'expires_at'
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
      when has_fail then 'fail'
      when has_warn then 'warn'
      when has_pass and not has_untested then 'pass'
      when has_pass and has_untested then 'partial'
      else 'untested'
    end as answer_status,
    evidence
  from per_q
  order by pos;
$$;

grant execute on function public.org_questionnaire_response(uuid, text) to authenticated, service_role;
