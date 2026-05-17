-- Continuous evidence collectors — the Vanta / Drata killer feature.
--
-- Today the wrapper's compliance_evidence rows come from one place:
-- engine scans. That means a control's verdict is only as fresh as
-- the last scan touching it. For most operational SaaS controls
-- (Okta MFA enforcement, GitHub 2FA requirement, AWS root MFA,
-- IAM password policy) you don't NEED a scan — you just poll the
-- service's admin API on a schedule.
--
-- This migration ships the scaffold:
--
--   1. compliance_evidence.source             text  — distinguishes
--      scan-emitted evidence from collector-emitted (UI / readiness
--      math can show "auto-collected from GitHub Admin at 03:14 UTC"
--      next to scan findings).
--
--   2. evidence_collectors                    per-org configuration
--      table — which collectors are enabled, paired integration, run
--      cadence, last-run state.
--
--   3. evidence_collector_runs                append-only audit log of
--      every collector run. Auditor pack reads this to demonstrate
--      "evidence was refreshed every 6 hours over the audit period."
--
--   4. upsert_collector_evidence()            service-role RPC the
--      worker / cron route calls to push a batch of rows in one
--      transaction. Idempotent per (org, framework, control_id,
--      source) — the latest run overwrites the previous reading
--      rather than accumulating duplicates.
--
--   5. due_collectors()                       cron helper. Returns
--      (org_id, collector_id, integration_id) tuples for every
--      enabled collector whose last_run_at is older than its
--      frequency_minutes — i.e. ready to run NOW.

-- ============================================================================
-- 1. compliance_evidence.source — auditor-visible provenance
-- ============================================================================

alter table public.compliance_evidence
  add column if not exists source text;

create index if not exists compliance_evidence_source
  on public.compliance_evidence (org_id, source)
  where source is not null;

comment on column public.compliance_evidence.source is
  'Provenance: ''scan:<scan_id>'' for engine-emitted, ''collector:<id>'' '
  'for continuous-evidence pull. UI groups rows by source so the auditor '
  'can see which controls are continuously attested vs scan-driven.';

-- Backfill scan-sourced rows so the column has signal from day one.
-- New scans will set it explicitly via worker_insert_evidence (follow-up).
update public.compliance_evidence
   set source = 'scan:' || scan_id
 where source is null
   and scan_id is not null;

-- ============================================================================
-- 2. evidence_collectors — per-org configuration
-- ============================================================================

create table if not exists public.evidence_collectors (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations on delete cascade,
  -- Collector identifier (e.g. 'github_admin', 'aws_iam'). Stable
  -- catalog of available collectors lives in code, not DB — this
  -- column just records which ones the org has wired.
  collector_id        text not null check (length(collector_id) between 1 and 100),
  -- Which integration to consume creds from. The collector code
  -- enforces that the integration's `type` matches what it needs
  -- (e.g. github_admin requires a github integration).
  integration_id      uuid references public.integrations on delete set null,
  enabled             boolean not null default true,
  -- How often to fire this collector. Default 60 minutes for
  -- admin-API polls (low cost, high freshness). Min 5 to prevent
  -- accidental DDoS of upstream APIs; max 10080 (1 week) so a
  -- forgotten collector still attests once per audit cycle.
  frequency_minutes   int not null default 60 check (frequency_minutes between 5 and 10080),
  -- Cron / run-tracking — the cron route uses these to decide
  -- which collectors are "due."
  last_run_at         timestamptz,
  last_run_status     text check (last_run_status in ('success', 'partial', 'error', 'skipped')),
  last_run_error      text,
  last_run_evidence_count int default 0,
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users on delete set null,
  unique (org_id, collector_id)
);

create index if not exists evidence_collectors_due
  on public.evidence_collectors (last_run_at)
  where enabled = true;

comment on table public.evidence_collectors is
  'Per-org configuration for the continuous evidence pulls. One row '
  'per (org × collector) — enable / disable / cadence settings. The '
  'cron route consumes these via due_collectors().';

alter table public.evidence_collectors enable row level security;

drop policy if exists evidence_collectors_org_read on public.evidence_collectors;
create policy evidence_collectors_org_read on public.evidence_collectors
  for select using (org_id = public.current_org_id());

drop policy if exists evidence_collectors_org_write on public.evidence_collectors;
create policy evidence_collectors_org_write on public.evidence_collectors
  for all
  using (org_id = public.current_org_id())
  with check (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'member')
    )
  );

-- ============================================================================
-- 3. evidence_collector_runs — append-only audit log
-- ============================================================================

create table if not exists public.evidence_collector_runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations on delete cascade,
  collector_id        text not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running'
    check (status in ('running', 'success', 'partial', 'error', 'skipped')),
  evidence_count      int not null default 0,
  error_message       text,
  -- Snapshot of what the run produced so the UI can show
  -- "the last run credited 6 controls" without re-running the join.
  produced_frameworks text[] not null default array[]::text[]
);

create index if not exists evidence_collector_runs_org_collector_started
  on public.evidence_collector_runs (org_id, collector_id, started_at desc);

create index if not exists evidence_collector_runs_started
  on public.evidence_collector_runs (started_at desc);

comment on table public.evidence_collector_runs is
  'Append-only audit log of every collector run. Auditor pack reads '
  'this to demonstrate evidence-refresh cadence over the audit period.';

alter table public.evidence_collector_runs enable row level security;

drop policy if exists evidence_collector_runs_org_read on public.evidence_collector_runs;
create policy evidence_collector_runs_org_read on public.evidence_collector_runs
  for select using (org_id = public.current_org_id());

-- ============================================================================
-- 4. upsert_collector_evidence — service-role batch upsert
-- ============================================================================
--
-- Called from the API route after a collector run completes. Takes a
-- JSONB array shape:
--
--   [
--     {
--       "framework":  "soc_2",
--       "control_id": "CC6.1",
--       "verdict":    "pass",
--       "detail":     { "expires_at": "...", ... },
--       "evidence_summary": "GitHub org requires 2FA for all members"
--     },
--     ...
--   ]
--
-- Per (org, framework, control_id, source) we delete any prior
-- collector-emitted row and insert the new one — this is upsert
-- semantics for the readiness math (compliance_evidence is consumed
-- as "latest verdict per control" downstream).

drop function if exists public.upsert_collector_evidence(uuid, text, jsonb);

create or replace function public.upsert_collector_evidence(
  p_org_id       uuid,
  p_collector_id text,
  p_evidence     jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text := 'collector:' || p_collector_id;
  v_row jsonb;
  v_inserted int := 0;
begin
  -- Delete prior collector-emitted rows for the controls we're about
  -- to write. We don't blanket-delete by source because a collector
  -- can produce evidence for many controls; we only want to evict
  -- the rows we're replacing.
  if jsonb_typeof(p_evidence) = 'array' then
    delete from public.compliance_evidence
     where org_id = p_org_id
       and source = v_source
       and (framework, control_id) in (
         select e->>'framework', e->>'control_id'
           from jsonb_array_elements(p_evidence) e
       );

    for v_row in select * from jsonb_array_elements(p_evidence)
    loop
      insert into public.compliance_evidence
        (org_id, scan_id, framework, control_id, verdict, detail,
         evidence_summary, source, observed_at)
      values (
        p_org_id,
        null,
        v_row->>'framework',
        v_row->>'control_id',
        v_row->>'verdict',
        coalesce(v_row->'detail', '{}'::jsonb),
        v_row->>'evidence_summary',
        v_source,
        now()
      );
      v_inserted := v_inserted + 1;
    end loop;
  end if;

  return v_inserted;
end;
$$;

revoke execute on function public.upsert_collector_evidence(uuid, text, jsonb) from public, anon, authenticated;
grant   execute on function public.upsert_collector_evidence(uuid, text, jsonb) to service_role;

comment on function public.upsert_collector_evidence(uuid, text, jsonb) is
  'Service-role batch upsert for collector-emitted evidence. Per-control '
  'replace semantics (delete the prior collector row, insert the new one) '
  'so the readiness math always reads the latest verdict.';

-- ============================================================================
-- 5. due_collectors — cron helper
-- ============================================================================

drop function if exists public.due_collectors();

create or replace function public.due_collectors()
returns table (
  collector_pk_id  uuid,
  org_id           uuid,
  collector_id     text,
  integration_id   uuid,
  frequency_minutes int,
  last_run_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    ec.id,
    ec.org_id,
    ec.collector_id,
    ec.integration_id,
    ec.frequency_minutes,
    ec.last_run_at
  from public.evidence_collectors ec
  where ec.enabled = true
    and (
      ec.last_run_at is null
      or ec.last_run_at + (ec.frequency_minutes * interval '1 minute') < now()
    )
  order by ec.last_run_at asc nulls first
  limit 100;
$$;

revoke execute on function public.due_collectors() from public, anon, authenticated;
grant   execute on function public.due_collectors() to service_role;

comment on function public.due_collectors() is
  'Service-role-only cron helper. Returns up to 100 enabled collectors '
  'whose last run is older than their frequency_minutes (or never ran). '
  'Ordered oldest-first so a backlog drains FIFO.';
