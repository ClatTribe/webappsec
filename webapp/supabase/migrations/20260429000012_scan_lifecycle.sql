-- Scan-lifecycle hardening (roadmap §1 ship-blockers).
--
-- Three problems addressed in one migration:
--
--   1. Atomic claim. Two workers receiving the same scan_queued NOTIFY both
--      tried to dispatch; the existing worker_start_scan was a conditional
--      UPDATE but its return type was void, so the loser silently
--      proceeded. We replace the fetch-then-start dance with a single
--      worker_claim_scan RPC that returns the scan row only if it actually
--      claimed it (status was 'queued'). Loser gets NULL and bails.
--
--   2. Stuck-scan recovery. A run that hangs (Gemini Pro 429 storm, network
--      partition, SIGKILL'd worker) leaves the row in 'running' indefinitely
--      — silently consuming a worker slot. We add scans.last_heartbeat_at,
--      a worker_heartbeat_scan RPC the worker calls every minute, and a
--      mark_stale_scans sweep that flips long-silent rows to 'failed'.
--
--   3. Cancel. Users today have no way to stop a runaway scan. We add
--      scans.cancel_requested_at + a request_scan_cancel RPC that sets the
--      flag and pg_notify('scan_cancel', scan_id). The worker listens on
--      that channel and SIGTERM's the matching subprocess.

-- =====================================================================
-- (1) Atomic claim
-- =====================================================================

create or replace function public.worker_claim_scan(p_scan_id uuid)
returns public.scans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scan public.scans;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_claim_scan requires service role';
  end if;

  -- Atomic flip from queued -> running. RETURNING * gives us the row only
  -- when this exact UPDATE matched a row (i.e. we won the race).
  update public.scans
  set status            = 'running',
      started_at        = now(),
      last_heartbeat_at = now()
  where id = p_scan_id
    and status = 'queued'
  returning * into v_scan;

  if v_scan.id is null then
    return null;
  end if;

  perform public.worker_insert_scan_event(p_scan_id, 'scan.started', null);
  return v_scan;
end;
$$;

revoke execute on function public.worker_claim_scan(uuid) from public, anon, authenticated;
grant   execute on function public.worker_claim_scan(uuid) to service_role;


-- =====================================================================
-- (2) Heartbeat + stuck-scan sweep
-- =====================================================================

alter table public.scans
  add column if not exists last_heartbeat_at timestamptz;

-- Surface the column in the UI's "running but silent for too long" badge.
create index if not exists scans_running_heartbeat
  on public.scans(last_heartbeat_at)
  where status = 'running';

create or replace function public.worker_heartbeat_scan(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_heartbeat_scan requires service role';
  end if;

  -- Only update while running. A heartbeat after the run was already marked
  -- terminal (cancel, finish) is a no-op — avoids ressurecting dead rows.
  -- clock_timestamp() rather than now() so the column reflects physical
  -- wall-clock time even when several heartbeats happen inside one
  -- transaction (test scenarios; not the production path).
  update public.scans
  set last_heartbeat_at = clock_timestamp()
  where id = p_scan_id
    and status = 'running';
end;
$$;

revoke execute on function public.worker_heartbeat_scan(uuid) from public, anon, authenticated;
grant   execute on function public.worker_heartbeat_scan(uuid) to service_role;


-- Sweep stale runs. Returns the ids it tipped to 'failed' so the caller can
-- log / page.
create or replace function public.mark_stale_scans(p_max_silence_seconds int default 600)
returns table(scan_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'mark_stale_scans requires service role';
  end if;

  return query
  with stale as (
    update public.scans s
    set status        = 'failed',
        finished_at   = coalesce(s.finished_at, now()),
        error_message = format(
          'worker heartbeat stopped %s seconds ago',
          extract(epoch from now() - coalesce(s.last_heartbeat_at, s.started_at))::int
        )
    where s.status = 'running'
      and coalesce(s.last_heartbeat_at, s.started_at, s.created_at)
            < now() - make_interval(secs => p_max_silence_seconds)
    returning s.id
  )
  select id from stale;
end;
$$;

revoke execute on function public.mark_stale_scans(int) from public, anon, authenticated;
grant   execute on function public.mark_stale_scans(int) to service_role;


-- =====================================================================
-- (3) Cancel
-- =====================================================================

alter table public.scans
  add column if not exists cancel_requested_at timestamptz;

-- Caller is the *user* (via their JWT), not the worker. We check org
-- membership via has_org_role (added in 20260427000009 to avoid recursion).
-- Service role can also call this for self-cancel scenarios (worker shutdown,
-- admin tooling).
create or replace function public.request_scan_cancel(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_status text;
begin
  select org_id, status into v_org_id, v_status
  from public.scans
  where id = p_scan_id;

  if v_org_id is null then
    raise exception 'scan not found';
  end if;

  if auth.role() <> 'service_role' then
    if not public.has_org_role(v_org_id, 'member') then
      raise exception 'not a member of this organisation';
    end if;
  end if;

  if v_status not in ('queued', 'running') then
    -- Already terminal. No-op rather than error so concurrent clicks are safe.
    return;
  end if;

  update public.scans
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where id = p_scan_id;

  -- The worker listens on this channel and SIGTERM's the subprocess.
  perform pg_notify('scan_cancel', p_scan_id::text);
end;
$$;

revoke execute on function public.request_scan_cancel(uuid) from public, anon;
grant   execute on function public.request_scan_cancel(uuid) to authenticated, service_role;
