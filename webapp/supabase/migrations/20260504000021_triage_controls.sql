-- Triage learning, phase 4: drift metric + reset controls.
--
-- Two related but independent capabilities:
--
--   1. `triage_drift_for_org()` — measures model calibration. The Phase
--      3 ε-greedy escape valve (5%) surfaces would-have-auto-dismissed
--      findings to the user instead of hiding them. The user's
--      eventual decision on those is the ground-truth signal we need:
--      if they confirm "yes, dismiss it" the model was right; if they
--      override "no, this is real", the model would have been wrong.
--      The override rate IS the calibration metric.
--
--      Why this works without explicit "drift detection" infra:
--      ε-explores are random samples from the would-have-dismissed
--      population, so the override rate over those is an unbiased
--      estimator of the auto-dismiss false-suppression rate. No
--      held-out set, no separate eval job — the policy itself is
--      structured to produce this signal continuously.
--
--   2. `reset_triage_signals(p_keep_days int)` — power-user control.
--      `null` = full wipe. `90` = keep last 90 days only (the typical
--      "stack changed shape, retrain on recent signal" use case).
--      Role-gated: only owner / admin can run it. Returns the deleted
--      row count so the UI can show "Reset 1,234 signals".

-- ============== triage_drift_for_org ==============
--
-- Returns null when there's nothing to measure (no ε-explored findings
-- or none yet triaged by the user). The UI treats null as "no drift
-- data yet — keep using the model normally".

create or replace function public.triage_drift_for_org()
returns jsonb
language sql
stable
set search_path = public
as $$
  with
  v_org as (select public.current_org_id() as org_id),
  explored as (
    select f.id, f.status
      from public.findings f, v_org
     where f.org_id = v_org.org_id
       and f.auto_dismiss_reason is not null
       and (f.auto_dismiss_reason->>'epsilon_explore')::boolean is true
  ),
  triaged as (
    select status from explored where status <> 'open'
  ),
  agg as (
    select
      (select count(*) from explored)::int as explored_count,
      count(*)::int as triaged_count,
      count(*) filter (where status in ('triaged_real','fixed'))::int as override_count
    from triaged
  )
  select case
    when triaged_count = 0 then null
    else jsonb_build_object(
      'explored_count', explored_count,
      'triaged_count',  triaged_count,
      'override_count', override_count,
      'override_rate',  round(override_count::numeric / triaged_count, 3),
      -- Heuristic threshold: >20% overrides on ε-explores means the
      -- auto-dismiss rule is misfiring often enough that the org owner
      -- should retrain on recent signal only.
      'drift_warning',  override_count::numeric / triaged_count > 0.20
    )
  end
  from agg;
$$;

grant execute on function public.triage_drift_for_org() to authenticated;

-- ============== reset_triage_signals ==============
--
-- DELETE on the user's own org's signals, gated to admin/owner.
-- Triage signals are training data — wiping them is a privileged
-- destructive action that resets the per-org KNN to cold start. The
-- alternative form (`p_keep_days = 90`) keeps the recent tail and
-- drops the rest, which is the more common "model went stale"
-- intervention.

create or replace function public.reset_triage_signals(p_keep_days int default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid := public.current_org_id();
  v_role  text;
  v_count int;
begin
  if v_org is null then
    raise exception 'reset_triage_signals: no org context in JWT';
  end if;

  -- Only owner or admin may reset training data.
  -- Note: `null not in (...)` is null, not true — so we must explicitly
  -- handle the no-membership case or a stranger calling the RPC slips
  -- through. Belt-and-braces: check is-null AND check role membership.
  select role into v_role
    from public.org_members
   where user_id = auth.uid() and org_id = v_org;

  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'reset_triage_signals requires owner/admin role (got: %)',
      coalesce(v_role, 'no membership');
  end if;

  if p_keep_days is null then
    delete from public.triage_signals where org_id = v_org;
  else
    if p_keep_days < 1 then
      raise exception 'p_keep_days must be NULL (full reset) or >= 1, got %', p_keep_days;
    end if;
    delete from public.triage_signals
     where org_id = v_org
       and decided_at < now() - (p_keep_days || ' days')::interval;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.reset_triage_signals(int) to authenticated;
