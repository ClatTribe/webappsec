-- Tier II #12 — Compliance audit-readiness score + quarterly snapshots.
--
-- "Are you SOC 2 compliant?" is the wrong question. The right one is
-- "what's your readiness *right now*?" — answered with a number.
--
-- This migration ships:
--
--   1. compliance_snapshots table — one row per (org × framework × quarter)
--      with the composite score + breakdown JSONB. Lets the UI show
--      "Q1: 68 → Q2: 81" as a defensible progress narrative.
--
--   2. compute_audit_readiness(org_id, framework) — live score for one
--      framework. Returns the 0-100 composite + the 5-component
--      breakdown so the UI can show the user *why* their score is 73.
--      Reuses the existing org_compliance_readiness() base and layers
--      cadence + open-findings + freshness on top.
--
--   3. compute_org_audit_readiness() — convenience wrapper that runs
--      the per-framework function for every framework the org has
--      questionnaire responses or compliance_evidence for. Drives the
--      /compliance and /trust score chips with one round-trip.
--
--   4. snapshot_audit_readiness() — service-role snapshotter that the
--      cron route calls quarterly. Idempotent per quarter (one row
--      per org × framework × quarter via the UNIQUE).
--
-- Algorithm (5 weighted components):
--
--   base_readiness    0.30  — pass-rate among non-untested (from existing RPC)
--   coverage          0.20  — fraction of framework controls touched at all
--   cadence           0.20  — < 7d=100 · < 30d=80 · < 90d=50 · > 90d=0
--   findings_drag     0.20  — 100 - (10×open_crit + 5×open_high), floor 0
--   freshness         0.10  — 100 - (5×stale_controls), floor 0
--
-- Component weights are deliberately conservative on freshness
-- because we don't yet require every control to set expires_at.
-- We'll rebalance toward freshness once engine PR #252's expiry
-- emission is universal.

-- ============================================================================
-- 1. compliance_snapshots
-- ============================================================================

create table if not exists public.compliance_snapshots (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete cascade,
  framework   text not null,
  -- Quarter is a string like '2026-Q2' for human-readable URL/UI use.
  -- We store it denormalised rather than as a date because the bucket
  -- semantics ("everything in Q2 2026") would otherwise have to be
  -- reconstructed on every query.
  quarter     text not null check (quarter ~ '^\d{4}-Q[1-4]$'),
  -- 0-100 composite score (also stored inside breakdown.composite_pct;
  -- the column gives us a fast index for "show score history" queries).
  score       integer not null check (score between 0 and 100),
  breakdown   jsonb not null,
  snapshot_at timestamptz not null default now(),
  unique (org_id, framework, quarter)
);

create index if not exists compliance_snapshots_org_framework_quarter
  on public.compliance_snapshots (org_id, framework, quarter desc);

comment on table public.compliance_snapshots is
  'Tier II #12 — quarterly snapshot of audit-readiness per (org, framework). '
  'One row per quarter; the cron job writes Q2 once and the trust page reads it forever.';

alter table public.compliance_snapshots enable row level security;

drop policy if exists compliance_snapshots_org_read on public.compliance_snapshots;
create policy compliance_snapshots_org_read on public.compliance_snapshots
  for select using (org_id = public.current_org_id());

-- Service-role inserts (the snapshot cron) bypass RLS naturally; no
-- additional policy needed.

-- ============================================================================
-- 2. compute_audit_readiness(org_id, framework)
-- ============================================================================

drop function if exists public.compute_audit_readiness(uuid, text);

create or replace function public.compute_audit_readiness(
  p_org_id    uuid,
  p_framework text
)
returns table (
  framework         text,
  composite_pct     integer,
  base_readiness_pct numeric,
  coverage_pct      numeric,
  cadence_pct       integer,
  findings_pct      integer,
  freshness_pct     integer,
  -- Surfaced so the breakdown card can show "you have 3 critical
  -- findings tagged against SOC 2 controls" inline with the score.
  open_crit_findings int,
  open_high_findings int,
  stale_controls     int,
  total_controls     int,
  touched_controls   int,
  days_since_last_scan int
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_base record;
  v_cadence_pct       int;
  v_findings_pct      int;
  v_freshness_pct     int;
  v_coverage_pct      numeric;
  v_composite         int;
  v_open_crit         int;
  v_open_high         int;
  v_stale             int;
  v_days              int;
  v_framework_key     text := p_framework;
begin
  -- 1. Base — pass-rate among non-untested controls (reuses the RPC
  -- shipped in migration 046, which is already SECURITY DEFINER and
  -- knows how to read org_compliance_posture_v).
  select * into v_base
  from public.org_compliance_readiness(p_org_id, p_framework);

  -- 2. Coverage — (total - untested) / total. Tells us how much of
  -- the framework's controls have been touched at all (any verdict
  -- other than 'untested').
  v_coverage_pct := case
    when coalesce(v_base.total, 0) = 0 then 0
    else round(100.0 * (v_base.total - coalesce(v_base.untested, 0))::numeric
               / nullif(v_base.total, 0), 1)
  end;

  -- 3. Cadence — pull days_since_last_scan from the freshest scan
  -- run_meta.compliance_posture across the org. NULL = never scanned;
  -- treat as worst-case (0 score).
  select coalesce(
    (s.run_meta->'compliance_posture'->>'days_since_last_scan')::int,
    9999
  )
    into v_days
    from public.scans s
   where s.org_id = p_org_id
     and s.run_meta ? 'compliance_posture'
   order by s.created_at desc
   limit 1;

  v_days := coalesce(v_days, 9999);

  v_cadence_pct := case
    when v_days <= 7   then 100
    when v_days <= 30  then  80
    when v_days <= 90  then  50
    else                      0
  end;

  -- 4. Findings drag — open critical + high findings tagged against
  -- this framework's control list. The compliance_controls JSONB
  -- shape is {soc2: [...], iso_27001: [...], ...} — we look up the
  -- per-framework key.
  --
  -- Framework-name → JSONB-key mapping (mirrors engine emission):
  --   'soc_2'        → 'soc2'
  --   everything else uses the same key (iso_27001, pci_dss, hipaa,
  --   nist_800_53, gdpr, owasp, fedramp)
  declare
    v_compliance_key text;
  begin
    v_compliance_key := case p_framework
      when 'soc_2' then 'soc2'
      else p_framework
    end;

    select
      count(*) filter (where f.severity = 'critical')::int,
      count(*) filter (where f.severity = 'high')::int
      into v_open_crit, v_open_high
      from public.findings f
     where f.org_id = p_org_id
       and f.status = 'open'
       and f.compliance_controls ? v_compliance_key
       and jsonb_array_length(f.compliance_controls->v_compliance_key) > 0;
  end;

  v_open_crit := coalesce(v_open_crit, 0);
  v_open_high := coalesce(v_open_high, 0);
  v_findings_pct := greatest(0, 100 - (10 * v_open_crit) - (5 * v_open_high));

  -- 5. Freshness — count compliance_evidence rows for this org/
  -- framework whose detail.expires_at has passed. Engine PR #252
  -- stamps that field per control; the trust-page query (migration
  -- 059) already uses the same predicate.
  --
  -- Note: alias the table because the OUT params declared in the
  -- RETURNS TABLE list shadow the bare column names.
  select count(*)::int
    into v_stale
    from public.compliance_evidence ce
   where ce.org_id    = p_org_id
     and ce.framework = p_framework
     and (ce.detail->>'expires_at') is not null
     and (ce.detail->>'expires_at')::timestamptz < now();

  v_stale := coalesce(v_stale, 0);
  v_freshness_pct := greatest(0, 100 - (5 * v_stale));

  -- 6. Composite — weighted average.
  v_composite := round(
      0.30 * coalesce(v_base.readiness_pct, 0)::numeric
    + 0.20 * v_coverage_pct
    + 0.20 * v_cadence_pct
    + 0.20 * v_findings_pct
    + 0.10 * v_freshness_pct
  )::int;
  v_composite := greatest(0, least(100, v_composite));

  return query
    select
      p_framework                                    as framework,
      v_composite                                    as composite_pct,
      coalesce(v_base.readiness_pct, 0)::numeric     as base_readiness_pct,
      v_coverage_pct                                 as coverage_pct,
      v_cadence_pct                                  as cadence_pct,
      v_findings_pct                                 as findings_pct,
      v_freshness_pct                                as freshness_pct,
      v_open_crit                                    as open_crit_findings,
      v_open_high                                    as open_high_findings,
      v_stale                                        as stale_controls,
      coalesce(v_base.total, 0)::int                 as total_controls,
      coalesce(v_base.total - v_base.untested, 0)::int as touched_controls,
      v_days                                         as days_since_last_scan;
end;
$$;

revoke execute on function public.compute_audit_readiness(uuid, text) from public, anon;
grant   execute on function public.compute_audit_readiness(uuid, text) to authenticated, service_role;

comment on function public.compute_audit_readiness(uuid, text) is
  'Tier II #12 — 0-100 audit-readiness score for one framework with the '
  '5-component breakdown. Stable (no side effects); safe to call on every '
  'page render of /compliance.';

-- ============================================================================
-- 3. compute_org_audit_readiness() — per-org, every framework
-- ============================================================================

drop function if exists public.compute_org_audit_readiness();

-- Note: same `out_` prefix discipline as snapshot_audit_readiness —
-- bare names like `framework`/`quarter`/`score` collide with column
-- references inside the function body when PG resolves identifiers.
create or replace function public.compute_org_audit_readiness()
returns table (
  out_framework         text,
  out_composite_pct     integer,
  out_base_readiness_pct numeric,
  out_coverage_pct      numeric,
  out_cadence_pct       integer,
  out_findings_pct      integer,
  out_freshness_pct     integer,
  out_open_crit_findings int,
  out_open_high_findings int,
  out_stale_controls     int,
  out_total_controls     int,
  out_touched_controls   int,
  out_days_since_last_scan int,
  -- Previous-quarter snapshot for delta display ("was 68 last quarter").
  out_prev_quarter       text,
  out_prev_score         integer
)
language plpgsql
security invoker
set search_path = public
stable
as $$
declare
  v_org uuid := public.current_org_id();
  v_framework text;
  v_prev_quarter text;
  v_prev_score   int;
  r record;
begin
  if v_org is null then
    return;
  end if;

  -- Iterate over every framework this org has at least one piece of
  -- compliance_evidence for. Source-of-truth on "has the org engaged
  -- with this framework?" — the engine writes per-control evidence
  -- rows on every scan, so any framework that's been mapped at least
  -- once appears here. (Questionnaire answers are not stored in their
  -- own table — they're derived live via org_compliance_posture_v
  -- from the same compliance_evidence rows.)
  for v_framework in
    select distinct ce.framework
      from public.compliance_evidence ce
     where ce.org_id = v_org
     order by 1
  loop
    -- Previous quarter snapshot lookup. We don't have a strict "last
    -- *full* quarter" requirement — just the latest snapshot row in a
    -- quarter older than the current one. We alias the table because
    -- the OUT params named `quarter` and `score` shadow the bare
    -- column names.
    select cs.quarter, cs.score
      into v_prev_quarter, v_prev_score
      from public.compliance_snapshots cs
     where cs.org_id    = v_org
       and cs.framework = v_framework
       and cs.quarter   <> to_char(date_trunc('quarter', now()), 'YYYY"-Q"Q')
     order by cs.quarter desc
     limit 1;

    for r in
      select * from public.compute_audit_readiness(v_org, v_framework)
    loop
      out_framework            := r.framework;
      out_composite_pct        := r.composite_pct;
      out_base_readiness_pct   := r.base_readiness_pct;
      out_coverage_pct         := r.coverage_pct;
      out_cadence_pct          := r.cadence_pct;
      out_findings_pct         := r.findings_pct;
      out_freshness_pct        := r.freshness_pct;
      out_open_crit_findings   := r.open_crit_findings;
      out_open_high_findings   := r.open_high_findings;
      out_stale_controls       := r.stale_controls;
      out_total_controls       := r.total_controls;
      out_touched_controls     := r.touched_controls;
      out_days_since_last_scan := r.days_since_last_scan;
      out_prev_quarter         := v_prev_quarter;
      out_prev_score           := v_prev_score;
      return next;
    end loop;
  end loop;
end;
$$;

grant execute on function public.compute_org_audit_readiness() to authenticated;

comment on function public.compute_org_audit_readiness() is
  'Tier II #12 — per-framework audit-readiness rows for the caller''s org. '
  'Each row carries the live score + the previous-quarter snapshot for '
  'delta display. Used by /compliance and the trust page.';

-- ============================================================================
-- 4. snapshot_audit_readiness() — service-role snapshotter
-- ============================================================================

drop function if exists public.snapshot_audit_readiness();

-- Note: OUT params use the `out_` prefix to avoid shadowing column
-- names inside the INSERT … ON CONFLICT clause (PG treats bare column
-- identifiers as plpgsql variables when an OUT param of the same name
-- exists, which breaks ON CONFLICT targets).
create or replace function public.snapshot_audit_readiness()
returns table (
  out_org_id     uuid,
  out_framework  text,
  out_quarter    text,
  out_score      integer,
  out_was_insert boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quarter text := to_char(date_trunc('quarter', now()), 'YYYY"-Q"Q');
  v_org record;
  v_framework text;
  v_score record;
  v_was_insert boolean;
begin
  for v_org in select id from public.organizations
  loop
    for v_framework in
      select distinct ce.framework
        from public.compliance_evidence ce
       where ce.org_id = v_org.id
    loop
      select * into v_score
      from public.compute_audit_readiness(v_org.id, v_framework);

      -- Idempotent upsert per (org × framework × quarter). On
      -- conflict we DO update — the cron may run multiple times in a
      -- quarter (e.g. weekly) and we want the snapshot to reflect
      -- the most recent computation.
      insert into public.compliance_snapshots
        (org_id, framework, quarter, score, breakdown, snapshot_at)
      values (
        v_org.id,
        v_framework,
        v_quarter,
        v_score.composite_pct,
        jsonb_build_object(
          'base_readiness_pct',   v_score.base_readiness_pct,
          'coverage_pct',         v_score.coverage_pct,
          'cadence_pct',          v_score.cadence_pct,
          'findings_pct',         v_score.findings_pct,
          'freshness_pct',        v_score.freshness_pct,
          'open_crit_findings',   v_score.open_crit_findings,
          'open_high_findings',   v_score.open_high_findings,
          'stale_controls',       v_score.stale_controls,
          'total_controls',       v_score.total_controls,
          'touched_controls',     v_score.touched_controls,
          'days_since_last_scan', v_score.days_since_last_scan
        ),
        now()
      )
      on conflict (org_id, framework, quarter) do update
        set score       = excluded.score,
            breakdown   = excluded.breakdown,
            snapshot_at = excluded.snapshot_at
      returning (xmax = 0) into v_was_insert;

      out_org_id     := v_org.id;
      out_framework  := v_framework;
      out_quarter    := v_quarter;
      out_score      := v_score.composite_pct;
      out_was_insert := v_was_insert;
      return next;
    end loop;
  end loop;
end;
$$;

revoke execute on function public.snapshot_audit_readiness() from public, anon, authenticated;
grant   execute on function public.snapshot_audit_readiness() to service_role;

comment on function public.snapshot_audit_readiness() is
  'Tier II #12 — service-role-only snapshotter called by the /api/cron route. '
  'Iterates every (org × framework) and upserts a row keyed by current quarter. '
  'Idempotent — safe to run weekly within a quarter.';

-- ============================================================================
-- 5. get_audit_readiness_for_trust(slug)  — public, anon-safe
--
-- Powers the per-framework score chip on the public trust page. We
-- gate on `organizations.trust_page_published = true` (the same
-- predicate get_trust_page_payload uses) so an unpublished org's
-- readiness data is not exposed.
-- ============================================================================

drop function if exists public.get_audit_readiness_for_trust(text);

create or replace function public.get_audit_readiness_for_trust(p_slug text)
returns table (
  out_framework        text,
  out_composite_pct    integer,
  out_latest_quarter   text,
  out_latest_score     integer,
  out_prev_quarter     text,
  out_prev_score       integer
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_org_id uuid;
  v_published boolean;
begin
  -- Verify slug exists AND trust page is enabled. The publication
  -- gate is checked in get_trust_page_payload(); we mirror it here so
  -- the score chip can't leak data for an org that hasn't opted in
  -- to public trust posture. Column name is `trust_page_enabled` per
  -- migration 047.
  select id, coalesce(trust_page_enabled, false)
    into v_org_id, v_published
    from public.organizations
   where slug = p_slug;

  if v_org_id is null or v_published is not true then
    return;
  end if;

  -- For each framework with at least one compliance_evidence row,
  -- emit the live composite + the latest two snapshots.
  return query
    with frameworks as (
      select distinct ce.framework
        from public.compliance_evidence ce
       where ce.org_id = v_org_id
    ),
    latest as (
      select cs.framework, cs.quarter, cs.score,
             row_number() over (partition by cs.framework order by cs.quarter desc) as rn
        from public.compliance_snapshots cs
       where cs.org_id = v_org_id
    ),
    snap as (
      select
        f.framework,
        max(case when l.rn = 1 then l.quarter end) as latest_quarter,
        max(case when l.rn = 1 then l.score   end) as latest_score,
        max(case when l.rn = 2 then l.quarter end) as prev_quarter,
        max(case when l.rn = 2 then l.score   end) as prev_score
      from frameworks f
      left join latest l on l.framework = f.framework
      group by f.framework
    )
    select
      s.framework        as out_framework,
      r.composite_pct    as out_composite_pct,
      s.latest_quarter   as out_latest_quarter,
      s.latest_score     as out_latest_score,
      s.prev_quarter     as out_prev_quarter,
      s.prev_score       as out_prev_score
      from snap s
      cross join lateral public.compute_audit_readiness(v_org_id, s.framework) r;
end;
$$;

revoke execute on function public.get_audit_readiness_for_trust(text) from public;
grant   execute on function public.get_audit_readiness_for_trust(text) to anon, authenticated;

comment on function public.get_audit_readiness_for_trust(text) is
  'Tier II #12 — anon-safe per-framework composite + quarterly history '
  'for the public trust page. Gated on organizations.trust_page_published.';
