-- Team-scope RLS enforcement on the three primary read paths
-- (targets / scans / findings).
--
-- Migration 086 shipped the data model + helper functions but did
-- NOT wire them into RLS — by design. Flipping every read path in
-- one go is the blast-radius scenario; landing the data model first
-- meant orgs could define teams + memberships without anything
-- changing behaviour. This migration is the second half: it makes
-- team scope actually filter reads.
--
-- Backwards-compat contract:
--
--   - Orgs with NO `team_targets` rows at all see ZERO behaviour
--     change. The existing helper user_can_view_target() returns
--     true when no scope rows exist, and that's the org-wide
--     default.
--   - Orgs with `team_targets` rows on SOME targets see those
--     specific targets scoped to their teams; everything else
--     stays org-wide.
--   - Org admins always see everything (admin bypass inside
--     user_can_view_target).
--   - Service-role bypasses RLS entirely — the worker, evidence
--     collector cron, and asset-discovery cron continue to read
--     across all targets in an org regardless of scope.
--
-- Scoping for scans + findings flows through `target_id` — a scan
-- (or finding) is visible iff its underlying target is visible.
-- We register two new helpers (`user_can_view_scan`,
-- `user_can_view_finding`) so the RLS policies stay one-liners.

-- ============================================================================
-- 1. user_can_view_scan(p_user_id, p_scan_id) — derived from target visibility
-- ============================================================================

create or replace function public.user_can_view_scan(
  p_user_id uuid,
  p_scan_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id   uuid;
  v_target_id uuid;
begin
  select org_id, target_id into v_org_id, v_target_id
    from public.scans
   where id = p_scan_id;
  if v_org_id is null then return false; end if;
  if public.has_org_role(v_org_id, 'admin') then return true; end if;
  -- Scans without a target_id (legacy / multi-target runs) are
  -- visible to any org member. Same fall-through as
  -- user_can_view_target's "no team_targets = org-wide".
  if v_target_id is null then return true; end if;
  return public.user_can_view_target(p_user_id, v_target_id);
end;
$$;

revoke execute on function public.user_can_view_scan(uuid, uuid)
  from public, anon;
grant execute on function public.user_can_view_scan(uuid, uuid)
  to authenticated, service_role;

-- ============================================================================
-- 2. user_can_view_finding(p_user_id, p_finding_id)
-- ============================================================================

create or replace function public.user_can_view_finding(
  p_user_id    uuid,
  p_finding_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id   uuid;
  v_target_id uuid;
begin
  select org_id, target_id into v_org_id, v_target_id
    from public.findings
   where id = p_finding_id;
  if v_org_id is null then return false; end if;
  if public.has_org_role(v_org_id, 'admin') then return true; end if;
  if v_target_id is null then return true; end if;
  return public.user_can_view_target(p_user_id, v_target_id);
end;
$$;

revoke execute on function public.user_can_view_finding(uuid, uuid)
  from public, anon;
grant execute on function public.user_can_view_finding(uuid, uuid)
  to authenticated, service_role;

-- ============================================================================
-- 3. Wrap the three read policies
-- ============================================================================
--
-- Each policy now ANDs the existing org_id check with the
-- corresponding team-scope helper. The helper short-circuits to true
-- in every "no scope set" case, so the AND is a no-op for orgs that
-- haven't adopted team scoping. We deliberately keep the original
-- `org_id = current_org_id()` predicate — the helper does its own
-- admin bypass via has_org_role, but defence-in-depth: the policy
-- should still refuse to return rows from another org if the helper
-- ever returned true incorrectly.

drop policy if exists targets_org_read on public.targets;
create policy targets_org_read on public.targets
  for select to authenticated
  using (
    org_id = public.current_org_id()
    and public.user_can_view_target(auth.uid(), id)
  );

drop policy if exists scans_org_read on public.scans;
create policy scans_org_read on public.scans
  for select to authenticated
  using (
    org_id = public.current_org_id()
    and public.user_can_view_scan(auth.uid(), id)
  );

drop policy if exists findings_org_read on public.findings;
create policy findings_org_read on public.findings
  for select to authenticated
  using (
    org_id = public.current_org_id()
    and public.user_can_view_finding(auth.uid(), id)
  );

comment on function public.user_can_view_target(uuid, uuid) is
  'Team-scope check for a target. Used by the targets / scans / '
  'findings RLS policies (migration 087). Returns true when (a) the '
  'user is org admin, OR (b) the target has no team_targets rows, '
  'OR (c) the user is a member of a team that owns it. Service-role '
  'callers bypass RLS entirely; this function is invoked by the '
  'planner for authenticated user reads only.';
