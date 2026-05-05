-- §19.5 Tier 5 row 7 — cost-cap configurator (engine PR #113).
--
-- Engine ships `--max-cost <usd>` and `--max-input-tokens <n>` self-exit
-- gates. When either threshold trips the engine emits a
-- `run.terminated` event with reason="budget_exceeded" and exits code 3
-- (EXIT_BUDGET_EXCEEDED). The wrapper plumbs the flags from per-scan
-- form inputs (per-org defaults are a future follow-up) and surfaces
-- the termination reason on the scan-page status card.
--
-- Schema additions are nullable — a scan with both columns null tells
-- the worker to omit the flags entirely, which is the engine's "no
-- budget" default.

alter table public.scans
  add column if not exists max_cost numeric,
  add column if not exists max_input_tokens integer;

-- Bump create_scan_with_targets to a 13-arg signature with the two
-- new optional caps. Drops the prior 11-arg overload (PGRST203
-- ambiguity protection — same pattern as migration 026 + 033).

create or replace function public.create_scan_with_targets(
  p_org_id          uuid,
  p_run_name        text,
  p_scan_mode       text,
  p_scope_mode      text,
  p_diff_base       text,
  p_instruction_text text,
  p_target_id       uuid,
  p_targets         jsonb,
  p_integration_ids uuid[],
  p_dns_only        boolean default false,
  p_branch          text default null,
  p_max_cost        numeric default null,
  p_max_input_tokens integer default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_scan_id uuid;
  v_target jsonb;
  v_int uuid;
  v_idx int := 0;
begin
  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    raise exception 'at least one target required';
  end if;

  insert into public.scans (
    org_id, user_id, target_id, run_name, status, scan_mode, scope_mode,
    diff_base, instruction_text, dns_only, branch, max_cost, max_input_tokens
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text, coalesce(p_dns_only, false),
    nullif(trim(p_branch), ''),
    -- Negative or zero budgets land as null — same as "no cap". The
    -- form already gates on positive values but defence in depth.
    case when p_max_cost is not null and p_max_cost > 0 then p_max_cost else null end,
    case when p_max_input_tokens is not null and p_max_input_tokens > 0 then p_max_input_tokens else null end
  )
  returning id into v_scan_id;

  for v_target in select jsonb_array_elements(p_targets)
  loop
    v_idx := v_idx + 1;
    insert into public.scan_targets (scan_id, type, value, workspace_subdir)
    values (
      v_scan_id,
      v_target->>'type',
      v_target->>'value',
      coalesce(v_target->>'workspace_subdir', 'target_' || v_idx)
    );
  end loop;

  if p_integration_ids is not null and array_length(p_integration_ids, 1) > 0 then
    foreach v_int in array p_integration_ids
    loop
      insert into public.scan_integrations (scan_id, integration_id)
      values (v_scan_id, v_int);
    end loop;
  end if;

  return v_scan_id;
end;
$$;

drop function if exists public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text
);

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer
) to authenticated, service_role;
