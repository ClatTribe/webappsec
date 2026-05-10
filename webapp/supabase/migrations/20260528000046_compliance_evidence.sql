-- Per-org structured compliance evidence — AISecurityEngineerUXRoadmap.md
-- §5 Phase C step 1.
--
-- Engine PR #219 §4b ships compliance_evidence.json: per-control verdicts
-- (pass/fail/warn/info/untested) keyed by framework. Until now the wrapper
-- only knew that "a compliance_pack landed" (migration 030's
-- compliance_pack_uploaded bool); the per-control structured data was
-- locked inside the zip. This migration adds the table that lets:
--
--   • The chat handler answer "how ready am I for SOC 2?" with a real
--     control-by-control breakdown.
--   • The per-org Living Trust Page (next PR) render the posture URL
--     external parties bookmark.
--   • The remediation-plan generator know exactly which controls are
--     failing and propose options.
--
-- One row per (scan, framework, control). Multiple scans against the
-- same asset produce a time series — the org_compliance_posture_v view
-- below picks the latest verdict per (org, framework, control).
--
-- All RLS-scoped by org_id. The worker writes via a SECURITY DEFINER
-- ingest RPC.

create table if not exists public.compliance_evidence (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  scan_id         uuid references public.scans on delete cascade,
  -- Free-text now so we don't have to migrate the constraint each time
  -- the engine adds a framework (HIPAA, PCI DSS 4.0, FedRAMP, …). The
  -- frontend renders unknown frameworks as collapsed cards with the
  -- raw string. Common values: 'soc2_type_2', 'iso_27001', 'pci_dss',
  -- 'hipaa', 'gdpr', 'fedramp_moderate'.
  framework       text not null,
  -- Engine's canonical control identifier — e.g. 'CC6.1' for SOC 2,
  -- 'A.5.1' for ISO 27001. Free-text for the same reason.
  control_id      text not null,
  verdict         text not null check (verdict in ('pass','fail','warn','info','untested')),
  -- Engine's structured per-control payload: list of evidence items,
  -- pointers to the findings + scan_events that proved the verdict,
  -- caveat / scope notes, etc. The trust page renders the summary; the
  -- full payload is available via the auditor share-link.
  detail          jsonb not null default '{}'::jsonb,
  -- Short markdown the trust page + chat surface render. Engine emits
  -- this; the wrapper does not re-derive it.
  evidence_summary text,
  observed_at     timestamptz not null default now()
);

create index if not exists compliance_evidence_org_fw_ctrl
  on public.compliance_evidence (org_id, framework, control_id, observed_at desc);

create index if not exists compliance_evidence_scan
  on public.compliance_evidence (scan_id);

comment on table public.compliance_evidence is
  'Per-org per-scan per-control compliance verdicts ingested from the '
  'engine compliance_evidence.json artefact (engine PR #219 §4b). '
  'Multiple rows per (org, framework, control) = time series; '
  'org_compliance_posture_v picks the latest verdict.';

alter table public.compliance_evidence enable row level security;

drop policy if exists compliance_evidence_org_read on public.compliance_evidence;
create policy compliance_evidence_org_read on public.compliance_evidence
  for select to authenticated
  using (org_id = public.current_org_id());

-- Member writes (e.g. operator overriding the engine's verdict) are
-- not in v1; only service role writes. If we later add user-overrides
-- we'll do it via an insert with a distinct source field, not by
-- editing engine-derived rows.

-- ============== INGEST RPC ==============
-- The worker calls this after parsing compliance_evidence.json from the
-- scan's artifact bundle. Inserts one row per (framework, control). Bulk
-- to keep the round trips down on the worker.

create or replace function public.worker_ingest_compliance_evidence(
  p_scan_id  uuid,
  p_evidence jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_count  int := 0;
  v_item   record;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_ingest_compliance_evidence requires service role';
  end if;

  select org_id into v_org_id from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  -- Expected payload shape (matching engine PR #219 §4b):
  --   {
  --     "soc2_type_2": {
  --       "CC6.1": {"verdict":"pass","summary":"...","detail":{...}},
  --       "CC7.2": {"verdict":"fail","summary":"...","detail":{...}}
  --     },
  --     "iso_27001": { ... }
  --   }
  --
  -- We iterate framework → controls.

  for v_item in
    select fw_key                    as framework,
           ctrl_key                  as control_id,
           ctrl_value->>'verdict'    as verdict,
           ctrl_value->>'summary'    as summary,
           coalesce(ctrl_value->'detail', '{}'::jsonb) as detail
    from jsonb_each(p_evidence) as fw(fw_key, fw_value)
    cross join lateral jsonb_each(fw_value) as ctrl(ctrl_key, ctrl_value)
    where ctrl_value->>'verdict' is not null
  loop
    -- Defensive: skip unknown verdicts so the CHECK constraint never bites
    -- the entire ingest. Better to drop one row than fail the whole pack.
    if v_item.verdict not in ('pass','fail','warn','info','untested') then
      raise notice 'skipping control % with unknown verdict %', v_item.control_id, v_item.verdict;
      continue;
    end if;

    insert into public.compliance_evidence (
      org_id, scan_id, framework, control_id,
      verdict, detail, evidence_summary
    )
    values (
      v_org_id, p_scan_id, v_item.framework, v_item.control_id,
      v_item.verdict, v_item.detail, v_item.summary
    );
    v_count := v_count + 1;
  end loop;

  -- Emit a scan_event so the trajectory + auditor pack mention the ingest.
  perform public.worker_insert_scan_event(
    p_scan_id, 'compliance_evidence.ingested',
    jsonb_build_object('controls_count', v_count)
  );

  return v_count;
end;
$$;

revoke execute on function public.worker_ingest_compliance_evidence(uuid, jsonb)
  from public, anon, authenticated;
grant   execute on function public.worker_ingest_compliance_evidence(uuid, jsonb)
  to service_role;

-- ============== LATEST-VERDICT VIEW ==============
-- "What's the current state of each control across all this org's scans?"
-- The chat handler + trust page read from this. DISTINCT ON (postgres
-- extension) picks the most-recently-observed verdict per (org, framework,
-- control) without needing a window function.

create or replace view public.org_compliance_posture_v as
select distinct on (org_id, framework, control_id)
  org_id,
  framework,
  control_id,
  verdict,
  detail,
  evidence_summary,
  scan_id  as observed_in_scan_id,
  observed_at
from public.compliance_evidence
order by org_id, framework, control_id, observed_at desc;

comment on view public.org_compliance_posture_v is
  'Latest verdict per (org, framework, control) across all that org''s scans. '
  'Chat handler + trust page read from this. Inherits RLS from '
  'compliance_evidence so each org sees only its own posture.';

-- ============== FRAMEWORK READINESS HELPER ==============
-- "How ready is this org for SOC 2?" → percentage of controls passing.
-- Used by the chat handler for the "how ready am I?" intent and the
-- trust-page top-line readiness metric.

create or replace function public.org_compliance_readiness(
  p_org_id    uuid,
  p_framework text
)
returns table (
  framework       text,
  total           int,
  passing         int,
  failing         int,
  warning         int,
  untested        int,
  readiness_pct   numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with c as (
    select verdict
      from public.org_compliance_posture_v
     where org_id    = p_org_id
       and framework = p_framework
  )
  select
    p_framework as framework,
    count(*)::int                                                       as total,
    count(*) filter (where verdict = 'pass')::int                       as passing,
    count(*) filter (where verdict = 'fail')::int                       as failing,
    count(*) filter (where verdict = 'warn')::int                       as warning,
    count(*) filter (where verdict in ('untested','info'))::int         as untested,
    case
      when count(*) filter (where verdict <> 'untested') = 0 then 0
      else round(
        100.0 * count(*) filter (where verdict = 'pass')
              / nullif(count(*) filter (where verdict <> 'untested'), 0)
      , 1)
    end as readiness_pct
  from c;
$$;

revoke execute on function public.org_compliance_readiness(uuid, text)
  from public, anon;
grant   execute on function public.org_compliance_readiness(uuid, text)
  to authenticated, service_role;
