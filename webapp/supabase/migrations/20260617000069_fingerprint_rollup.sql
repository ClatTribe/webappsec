-- Tier II #11 — Cross-scan finding rollup.
--
-- Today the wrapper has `findings.fingerprint` (engine-emitted, stable
-- across scans) but the UI never groups by it across targets. A
-- vulnerability that shows up in 12 of your 30 repos surfaces as 12
-- independent rows in the Findings list — and gets triaged 12 times.
--
-- This migration ships:
--
--   1. fingerprint_rollup() RPC — returns one row per fingerprint per
--      org, with counts (targets, occurrences, by-status) + the
--      canonical title/severity/CWE/CVE drawn from the most-recent
--      occurrence. Only surfaces fingerprints hitting >= 2 distinct
--      targets — single-target findings already live in the regular
--      Findings list and would be noise here.
--
--   2. fingerprint_targets(p_fingerprint) RPC — returns the per-target
--      breakdown for one fingerprint (drill-in view). Each row has
--      target_id, target_name, target_value, finding_id, status,
--      last_seen_at — so the UI can show "acme/frontend: open ·
--      acme/admin: fixed · acme/marketing: open" inline.
--
--   3. triage_finding_fingerprint() RPC — bulk update all currently-OPEN
--      occurrences sharing a fingerprint. Resolved statuses (fixed /
--      false_positive / wont_fix) are NOT touched: if you already
--      decided some occurrences are fixed, a bulk "wont_fix" must not
--      flip them back to open. The RPC returns the count of rows it
--      actually updated.
--
-- All three are SECURITY INVOKER so RLS on findings + scans applies.
-- The user can only roll up / triage findings their org owns.

-- ============================================================================
-- fingerprint_rollup() — list view
-- ============================================================================

drop function if exists public.fingerprint_rollup();

create or replace function public.fingerprint_rollup()
returns table (
  fingerprint        text,
  title              text,
  severity           text,
  cwe                text,
  cve                text,
  occurrence_count   bigint,
  target_count       bigint,
  open_count         bigint,
  triaged_real_count bigint,
  fixed_count        bigint,
  false_positive_count bigint,
  wont_fix_count     bigint,
  first_seen_at      timestamptz,
  last_seen_at       timestamptz,
  -- Highest urgency tier observed across occurrences. Drives the
  -- "this group has open critical fix-nows" callout on the row.
  max_urgency        text
)
language sql
security invoker
set search_path = public
as $$
  with org as (
    select public.current_org_id() as id
  ),
  ranked as (
    select
      f.fingerprint,
      f.title,
      f.severity,
      f.cwe,
      f.cve,
      f.status,
      f.created_at,
      s.target_id,
      f.ai_assessment->>'urgency' as urgency,
      -- Latest occurrence per fingerprint wins for the canonical title.
      row_number() over (
        partition by f.fingerprint
        order by f.created_at desc
      ) as rn_latest
    from public.findings f
    join public.scans s on s.id = f.scan_id, org
    where f.org_id = org.id
      and f.fingerprint is not null
      and f.is_canonical is not false  -- skip non-canonical dup rows from migration 010
  )
  select
    r.fingerprint,
    (select title    from ranked where fingerprint = r.fingerprint and rn_latest = 1 limit 1) as title,
    (select severity from ranked where fingerprint = r.fingerprint and rn_latest = 1 limit 1) as severity,
    (select cwe      from ranked where fingerprint = r.fingerprint and rn_latest = 1 limit 1) as cwe,
    (select cve      from ranked where fingerprint = r.fingerprint and rn_latest = 1 limit 1) as cve,
    count(*)                                                       as occurrence_count,
    count(distinct r.target_id)                                    as target_count,
    count(*) filter (where r.status = 'open')                      as open_count,
    count(*) filter (where r.status = 'triaged_real')              as triaged_real_count,
    count(*) filter (where r.status = 'fixed')                     as fixed_count,
    count(*) filter (where r.status = 'false_positive')            as false_positive_count,
    count(*) filter (where r.status = 'wont_fix')                  as wont_fix_count,
    min(r.created_at)                                              as first_seen_at,
    max(r.created_at)                                              as last_seen_at,
    -- max() over a text enum needs an explicit order. fix_now > fix_soon > monitor > dismiss.
    case
      when bool_or(r.urgency = 'fix_now')  then 'fix_now'
      when bool_or(r.urgency = 'fix_soon') then 'fix_soon'
      when bool_or(r.urgency = 'monitor')  then 'monitor'
      when bool_or(r.urgency = 'dismiss')  then 'dismiss'
      else null
    end as max_urgency
  from ranked r
  group by r.fingerprint
  having count(distinct r.target_id) >= 2
  order by
    -- Severity-then-target-count sort. We want users to see "this
    -- critical hit 12 repos" at the top, not "this info hit 30 repos".
    case (select severity from ranked where fingerprint = r.fingerprint and rn_latest = 1 limit 1)
      when 'critical' then 0
      when 'high'     then 1
      when 'medium'   then 2
      when 'low'      then 3
      when 'info'     then 4
      else 5
    end,
    count(distinct r.target_id) desc,
    count(*) filter (where r.status = 'open') desc;
$$;

grant execute on function public.fingerprint_rollup() to authenticated;

comment on function public.fingerprint_rollup() is
  'Tier II #11 — per-fingerprint rollup across the org. Returns only '
  'fingerprints hitting >= 2 distinct targets. Used by /findings/recurring.';

-- ============================================================================
-- fingerprint_targets(p_fingerprint) — drill-in view
-- ============================================================================

drop function if exists public.fingerprint_targets(text);

create or replace function public.fingerprint_targets(p_fingerprint text)
returns table (
  finding_id     uuid,
  target_id      uuid,
  target_name    text,
  target_value   text,
  target_type    text,
  scan_id        uuid,
  scan_name      text,
  status         text,
  severity       text,
  created_at     timestamptz,
  last_seen_at   timestamptz,
  times_seen     integer
)
language sql
security invoker
set search_path = public
as $$
  select
    f.id           as finding_id,
    t.id           as target_id,
    t.name         as target_name,
    t.value        as target_value,
    t.type         as target_type,
    s.id           as scan_id,
    s.run_name     as scan_name,
    f.status,
    f.severity,
    f.created_at,
    f.last_seen_at,
    f.times_seen
  from public.findings f
  join public.scans   s on s.id = f.scan_id
  left join public.targets t on t.id = s.target_id
  where f.fingerprint = p_fingerprint
    and f.org_id = public.current_org_id()
    and f.is_canonical is not false
  order by
    -- open first, then by recency
    case f.status
      when 'open' then 0
      when 'triaged_real' then 1
      when 'fixed' then 2
      when 'wont_fix' then 3
      when 'false_positive' then 4
      else 5
    end,
    f.created_at desc;
$$;

grant execute on function public.fingerprint_targets(text) to authenticated;

comment on function public.fingerprint_targets(text) is
  'Tier II #11 — per-target breakdown for one fingerprint. Drill-in '
  'view from the rollup row.';

-- ============================================================================
-- triage_finding_fingerprint() — bulk triage
-- ============================================================================

drop function if exists public.triage_finding_fingerprint(text, text, text);

create or replace function public.triage_finding_fingerprint(
  p_fingerprint text,
  p_status      text,
  p_reason      text default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated integer;
  v_org uuid := public.current_org_id();
  v_uid uuid := auth.uid();
begin
  if v_org is null then
    raise exception 'no org context';
  end if;
  if p_status not in ('triaged_real', 'fixed', 'false_positive', 'wont_fix', 'open') then
    raise exception 'invalid status: %', p_status;
  end if;

  -- We only touch rows currently in `open`. The intent of bulk-triage
  -- is "I just decided this whole class is X" — if some occurrences
  -- were already triaged (e.g., a teammate marked one fixed yesterday),
  -- we leave their judgement alone. The route layer surfaces the
  -- updated_count so the UI can say "marked 8 of 12 — 4 already triaged".
  --
  -- The one exception: `reopen` (status = 'open') opens all non-open
  -- rows. That's a separate user intent ("this came back, reopen
  -- everything") and a fresh open status is non-destructive.
  if p_status = 'open' then
    update public.findings
       set status      = 'open',
           triaged_by  = v_uid,
           triaged_at  = now(),
           triage_notes = coalesce(p_reason, triage_notes)
     where fingerprint = p_fingerprint
       and org_id      = v_org
       and status      <> 'open'
       and is_canonical is not false;
  else
    update public.findings
       set status      = p_status,
           triaged_by  = v_uid,
           triaged_at  = now(),
           triage_notes = coalesce(p_reason, triage_notes),
           -- Stash the reason on wont_fix occurrences so the audit pack
           -- has the rationale tied to the row, not just the
           -- triage_notes column.
           wont_fix_reason = case
             when p_status = 'wont_fix' then coalesce(p_reason, wont_fix_reason)
             else wont_fix_reason
           end
     where fingerprint = p_fingerprint
       and org_id      = v_org
       and status      = 'open'
       and is_canonical is not false;
  end if;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

grant execute on function public.triage_finding_fingerprint(text, text, text) to authenticated;

comment on function public.triage_finding_fingerprint(text, text, text) is
  'Tier II #11 — bulk triage all OPEN occurrences of one fingerprint. '
  'Pre-resolved rows (fixed / false_positive / wont_fix) are left '
  'alone — bulk triage is a forward op, never a destructive override.';
