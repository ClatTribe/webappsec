-- §19.5 Tier 5 row 1 — branch picker for repository scans (engine PR #117).
--
-- Engine ships `--branch <ref>` so a repository scan can target a specific
-- branch / tag / SHA without checking out the wrong tree first. The wrapper
-- exposes this via a free-text input on the new-scan form (a full branch
-- DROPDOWN sourced from the GitHub API is out of scope for this slice —
-- requires a connected GitHub integration to enumerate refs).
--
-- Same overload-replacement pattern as migration 026's dns_only addition:
-- bump the RPC to an 11-arg signature with `p_branch` defaulting to null,
-- drop the old 10-arg form so supabase-py can't pick the wrong overload.

alter table public.scans
  add column if not exists branch text;

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
  p_branch          text default null
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
    diff_base, instruction_text, dns_only, branch
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text, coalesce(p_dns_only, false),
    nullif(trim(p_branch), '')
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

-- Drop the prior 10-arg overload — PGRST203 ambiguity protection.
drop function if exists public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean
);

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text
) to authenticated, service_role;
