-- §19.1 Tier 1 slice 2 — engine flags + scan-status taxonomy.
--
-- Two small additions:
--
--   1. `scans.dns_only` boolean. Engine PR #30's --dns-only / STRIX_DNS_ONLY
--      flag for passive recon on domain targets. The wrapper UI surfaces a
--      "Surface-map only" toggle; the worker forwards STRIX_DNS_ONLY=1 into
--      the sandbox env. Persisted on the scan row so the run-detail page
--      can render a "Passive recon mode" badge after-the-fact.
--
--   2. `scans.preflight_failed` boolean. Engine PR #29 makes --preflight
--      default ON: targets that don't resolve / have no port answer exit 1
--      in ~5 seconds with a diagnostic panel, instead of running the full
--      agent loop. The wrapper distinguishes that from a real scan-engine
--      failure so the UI can render "Target unreachable" with the
--      diagnostic, vs. "Scan crashed".
--
-- Both columns default false; existing scans land with false on backfill.

alter table public.scans
  add column if not exists dns_only boolean not null default false,
  add column if not exists preflight_failed boolean not null default false;

-- Extend the atomic scan-create RPC. The existing 9-arg signature stays
-- callable (defaults p_dns_only to false), so no API caller breaks; we
-- just add the new arg as the last positional.

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
  p_dns_only        boolean default false
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
    diff_base, instruction_text, dns_only
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text, coalesce(p_dns_only, false)
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

-- Drop the old 9-arg overload — Postgres distinguishes overloads by
-- argument types but the supabase-py client picks by name; keeping the
-- 9-arg signature alongside causes RPC ambiguity errors. The new 10-arg
-- form covers both code paths via the default.
drop function if exists public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[]
);

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean
) to authenticated, service_role;
