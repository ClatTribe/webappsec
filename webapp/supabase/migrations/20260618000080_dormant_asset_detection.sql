-- Stale-asset detection — Phase F of org-scale onboarding.
--
-- After a customer onboards 200 targets via bulk import (Phase D) or
-- bulk asset discovery (Phase A), the inventory accumulates entropy.
-- Repos get archived upstream. Services get deprecated. Test
-- environments stay registered long after they've been deleted from
-- AWS. Today we keep scanning them — burning LLM budget on dead
-- assets — and clutter the UI.
--
-- This migration introduces the `dormant` state: an intermediate
-- between `active` and `archived` where we've noticed an asset hasn't
-- been touched recently but haven't archived it yet. The customer
-- reviews and either restores or archives.
--
-- Detection heuristics (all OR'd):
--
--   1. last_scan_at >= 90 days ago AND scan_frequency != 'manual'
--      → we're scheduled to scan but the last scan was long ago. Most
--      likely a runtime error (target unreachable, integration
--      revoked) silently swallowed.
--
--   2. last_scan_at IS NULL AND created_at >= 60 days ago
--      → registered and never scanned. Discovered then forgotten.
--
--   3. For repository targets: the linked integration is no longer
--      active. (Cascade-delete on integration removal would lose
--      history; flipping to dormant preserves the audit trail.)
--
-- Wrapper-side concern only — the engine sees a flat list of active
-- targets per scan and doesn't need to know about dormancy.

-- ============================================================================
-- 1. targets.status enum widening
-- ============================================================================
--
-- Add `dormant` to the existing check. Existing rows untouched (only
-- 'active' / 'archived' present today).

alter table public.targets drop constraint if exists targets_status_check;
alter table public.targets
  add constraint targets_status_check
  check (status in ('active','dormant','archived'));

comment on column public.targets.status is
  'active = scheduled scans run; dormant (Phase F) = no recent activity '
  'detected, awaiting review; archived = soft-deleted (kept for audit).';

-- The targets_org_active index in migration 040 filtered to status=active.
-- We DON''T widen it — dormant rows should NOT continue to be considered
-- for cadence-driven scans. The wrapper's scan dispatcher already
-- filters by status='active' so this gives us the right behaviour for
-- free (dormant targets stop being scanned automatically).

-- ============================================================================
-- 2. dormancy reason — track WHY we flipped a row
-- ============================================================================

alter table public.targets
  add column if not exists dormancy_reason text,
  add column if not exists dormancy_detected_at timestamptz;

comment on column public.targets.dormancy_reason is
  'When status=dormant, a short machine-readable code: '
  'no_recent_scans / never_scanned / integration_removed. Surfaced in '
  'the UI banner so the customer can fix root cause before restoring.';

-- ============================================================================
-- 3. sweep_dormant_targets RPC — service-role-only
-- ============================================================================
--
-- The cron calls this. Marks targets dormant when any heuristic fires;
-- returns per-row outcomes (target_id, old_status, new_status, reason)
-- so the cron can log the transition + emit chat notifications later.
--
-- Idempotent — already-dormant rows are not touched (no-op).
-- Restoration (dormant → active) is a separate user-initiated action,
-- NOT done here.

create or replace function public.sweep_dormant_targets(
  p_no_scan_age_days   integer default 90,
  p_never_scanned_days integer default 60
)
returns table (
  target_id     uuid,
  org_id        uuid,
  old_status    text,
  new_status    text,
  reason        text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
begin
  -- Lock down to service role + admin only. The cron runs as
  -- service_role; an admin can invoke manually via psql / a future
  -- "sweep now" button.
  v_caller := current_setting('role', true);
  if v_caller not in ('service_role', 'postgres') then
    if not public.has_org_role(public.current_org_id(), 'admin') then
      raise exception 'admin role or service_role required';
    end if;
  end if;

  -- Heuristic A — last_scan_at older than threshold, AND scheduled
  -- (scan_frequency != 'manual', otherwise it's expected to be quiet).
  return query
  with
    candidates as (
      -- A: never scanned, registered too long ago
      select
        t.id, t.org_id, t.status,
        'never_scanned'::text as reason
      from public.targets t
      where t.status = 'active'
        and t.last_scan_at is null
        and t.created_at < now() - make_interval(days => p_never_scanned_days)

      union all

      -- B: last scan too long ago
      select
        t.id, t.org_id, t.status,
        'no_recent_scans'::text as reason
      from public.targets t
      where t.status = 'active'
        and t.last_scan_at is not null
        and t.last_scan_at < now() - make_interval(days => p_no_scan_age_days)
        and t.scan_frequency in ('daily','weekly','monthly')

      union all

      -- C: parent integration is no longer active. We resolve via
      -- targets.metadata.integration_id when set (asset-discovery
      -- writes it; bulk-import may also). Targets without an
      -- integration link are exempt.
      select
        t.id, t.org_id, t.status,
        'integration_removed'::text as reason
      from public.targets t
      where t.status = 'active'
        and t.metadata ? 'integration_id'
        and not exists (
          select 1 from public.integrations i
          where i.id = (t.metadata->>'integration_id')::uuid
            and i.status = 'active'
        )
    ),
    flipped as (
      update public.targets t
         set status               = 'dormant',
             dormancy_reason      = c.reason,
             dormancy_detected_at = now()
        from candidates c
       where t.id = c.id
         and t.status = 'active' -- defensive: prevent double-flip
       returning t.id, t.org_id, c.reason, 'active'::text as old_st
    )
  select
    f.id,
    f.org_id,
    f.old_st,
    'dormant'::text,
    f.reason
  from flipped f;
end;
$$;

revoke execute on function public.sweep_dormant_targets(integer, integer)
  from public, anon;
grant execute on function public.sweep_dormant_targets(integer, integer)
  to authenticated, service_role;

comment on function public.sweep_dormant_targets(integer, integer) is
  'Phase F — flip stale active targets to status=dormant. Cron runs '
  'this daily; returns per-row transitions so the caller can audit-log '
  'or notify. Idempotent.';

-- ============================================================================
-- 4. restore_dormant_target RPC — user-initiated promotion back
-- ============================================================================

create or replace function public.restore_dormant_target(p_target_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_user_id uuid;
begin
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null then
    raise exception 'no active org';
  end if;

  update public.targets
     set status               = 'active',
         dormancy_reason      = null,
         dormancy_detected_at = null
   where id = p_target_id
     and org_id = v_org_id
     and status = 'dormant';
  if not found then
    return false;
  end if;

  insert into public.audit_log (
    org_id, user_id, action, resource_type, resource_id
  ) values (
    v_org_id, v_user_id,
    'target.restored_from_dormant',
    'target',
    p_target_id
  );
  return true;
end;
$$;

revoke execute on function public.restore_dormant_target(uuid) from public, anon;
grant execute on function public.restore_dormant_target(uuid)
  to authenticated, service_role;
