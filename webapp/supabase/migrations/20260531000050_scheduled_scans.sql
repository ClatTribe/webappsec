-- Continuous scanning — AISecurityEngineerUXRoadmap.md §8 Phase F v1.
--
-- Targets carry a scan_frequency (manual / daily / weekly / monthly —
-- migration 011) and a richer schedule jsonb (migration 040). v1 wires
-- scan_frequency: every minute the worker calls
-- worker_enqueue_scheduled_scans(), which finds active non-manual
-- targets whose last_scan_at is older than the cadence window and
-- enqueues a new scan for each. The existing pg_notify('scan_queued')
-- trigger picks each up and runs it through the normal scan pipeline.
--
-- Idempotence: targets_due_for_scheduled_scan() checks for any
-- already-queued/running scan for the same target — if one exists, the
-- target isn't due. This prevents the daemon from piling scans up if a
-- previous one is still in flight.
--
-- Reliability: the RPC is service-role-only. Per-target inserts are
-- isolated — a failure on one target doesn't abort the loop. Worker
-- exception-traps the whole call.
--
-- v2 (separate PR) consults the schedule jsonb column for richer
-- cadences (cron expressions, on_push triggers, per-asset overrides).

-- ============== DUE-TARGETS VIEW + HELPER ==============

create or replace function public.targets_due_for_scheduled_scan(
  p_now timestamptz default now()
)
returns table (
  target_id     uuid,
  org_id        uuid,
  created_by    uuid,
  type          text,
  value         text,
  name          text,
  scan_frequency text,
  last_scan_at  timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id            as target_id,
    t.org_id        as org_id,
    t.created_by    as created_by,
    t.type          as type,
    t.value         as value,
    t.name          as name,
    t.scan_frequency as scan_frequency,
    t.last_scan_at  as last_scan_at
  from public.targets t
  where t.status = 'active'
    and t.scan_frequency in ('daily','weekly','monthly')
    and (
      t.last_scan_at is null
      or (t.scan_frequency = 'daily'   and t.last_scan_at < p_now - interval '1 day')
      or (t.scan_frequency = 'weekly'  and t.last_scan_at < p_now - interval '7 days')
      or (t.scan_frequency = 'monthly' and t.last_scan_at < p_now - interval '30 days')
    )
    -- Skip if an in-flight scan already exists for this target. The
    -- target's last_scan_at is bumped at scan-end (migration 011's
    -- update_target_last_scan_at trigger), so during a long-running
    -- scan this column would still report the previous time, and we
    -- could double-enqueue. The subquery is the guard.
    and not exists (
      select 1 from public.scans s
      where s.target_id = t.id
        and s.status in ('queued','running')
    );
$$;

revoke execute on function public.targets_due_for_scheduled_scan(timestamptz)
  from public, anon, authenticated;
grant   execute on function public.targets_due_for_scheduled_scan(timestamptz)
  to service_role;

comment on function public.targets_due_for_scheduled_scan(timestamptz) is
  'Lists targets whose cadence is up for another scheduled scan. '
  'Filters: status=active, frequency in (daily,weekly,monthly), '
  'last_scan_at older than cadence, no scan already in flight.';

-- ============== ENQUEUE RPC ==============

create or replace function public.worker_enqueue_scheduled_scans()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_target record;
  v_scan_id uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_enqueue_scheduled_scans requires service role';
  end if;

  for v_target in
    select * from public.targets_due_for_scheduled_scan(now())
    limit 500   -- defensive cap so a backlog can't cascade into 10k inserts
  loop
    begin
      insert into public.scans (
        org_id,
        target_id,
        user_id,
        run_name,
        scan_mode,
        status
      )
      values (
        v_target.org_id,
        v_target.target_id,
        v_target.created_by,
        format(
          'Scheduled %s scan of %s',
          v_target.scan_frequency,
          coalesce(v_target.name, v_target.value)
        ),
        'quick',
        'queued'
      )
      returning id into v_scan_id;

      -- The scan_targets row is what the existing pipeline expects;
      -- the per-scan dedup trigger from migration 011 will also
      -- backfill scans.target_id when populated, but we set both
      -- explicitly to keep the path obvious.
      insert into public.scan_targets (scan_id, type, value)
      values (v_scan_id, v_target.type, v_target.value);

      v_count := v_count + 1;
    exception
      when others then
        -- Per-target failure logged via NOTICE; loop continues. A
        -- single bad target shouldn't poison the whole sweep.
        raise notice
          'enqueue scheduled scan for target % failed: %',
          v_target.target_id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.worker_enqueue_scheduled_scans()
  from public, anon, authenticated;
grant   execute on function public.worker_enqueue_scheduled_scans()
  to service_role;

comment on function public.worker_enqueue_scheduled_scans() is
  'Periodically called by the worker (every ~60s) to enqueue scheduled '
  'scans for targets whose cadence is due. Inserts scan rows with '
  'status=queued — existing scan_queued trigger pg_notifies the worker '
  'fleet, which picks them up via the normal dispatch path.';
