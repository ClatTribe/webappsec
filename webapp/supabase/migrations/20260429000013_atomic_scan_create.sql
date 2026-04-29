-- Atomic scan creation — fixes a race the API has had since day one.
--
-- Today `POST /api/scans/route.ts` does three sequential inserts under the
-- user's JWT:
--   1. INSERT INTO scans (status='queued')   → trigger queues a pg_notify
--   2. INSERT INTO scan_targets (...)
--   3. INSERT INTO scan_integrations (...)   (optional)
--
-- Each is its own HTTP round-trip → its own Postgres transaction. The
-- pg_notify fires when transaction (1) commits, *before* (2) and (3) hit
-- the DB. A worker LISTENing on `scan_queued` can race in: claim the scan,
-- fetch the joined view, see zero targets, invoke Strix without `-t`,
-- argparse-fail, and silently mark the scan completed (Strix exits 2 on
-- arg errors and our worker treats 0/2 as success).
--
-- We hit this empirically while running a real getedunext.com scan from a
-- script. Production users hit it less often only because real human latency
-- between the inserts is usually larger than the worker's claim → fetch
-- window — but the race is real and grows worse as worker latency drops.
--
-- Fix: one server-side function that does all three inserts in one
-- transaction. The `notify_scan_queued` trigger still fires on the scans
-- insert, but Postgres holds notifications until COMMIT — so by the time
-- the worker is woken, scan_targets + scan_integrations are guaranteed
-- visible.

create or replace function public.create_scan_with_targets(
  p_org_id          uuid,
  p_run_name        text,
  p_scan_mode       text,
  p_scope_mode      text,
  p_diff_base       text,
  p_instruction_text text,
  p_target_id       uuid,
  p_targets         jsonb,         -- array of {type, value, workspace_subdir}
  p_integration_ids uuid[]
)
returns uuid
language plpgsql
security invoker                   -- caller's JWT; RLS applies on every insert
set search_path = public
as $$
declare
  v_scan_id uuid;
  v_target jsonb;
  v_int uuid;
  v_idx int := 0;
begin
  -- The inserts below all go through RLS as the calling user. The user must
  -- be a member of p_org_id (scans WITH CHECK enforces this), so no extra
  -- membership check needed here.

  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    raise exception 'at least one target required';
  end if;

  insert into public.scans (
    org_id, user_id, target_id, run_name, status, scan_mode, scope_mode,
    diff_base, instruction_text
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text
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

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[]
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[]
) to authenticated, service_role;
