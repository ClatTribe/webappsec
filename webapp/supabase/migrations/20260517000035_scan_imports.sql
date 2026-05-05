-- Tier A — HAR / Burp project upload (engine PR #141 / wishlist §15.2).
--
-- Most real-world pen-tests start with a Burp recording or HAR export.
-- The engine ships `ingest_har_file(path)` and `ingest_burp_file(path)`
-- tools (engine PR #141) — agent-driven ingestion, not a CLI flag.
--
-- The wrapper accepts file uploads against the existing `user-uploads`
-- bucket (created in migration 001), then attaches a list of
-- {kind, storage_path, filename, size_bytes} references to each scan.
-- The worker copies each file from storage into the per-scan workdir
-- and appends an instruction to the agent telling it about the
-- pre-positioned imports — the agent then chooses to call
-- ingest_har_file / ingest_burp_file as part of its recon flow.
--
-- Per Architecture.md §1.1 the wrapper doesn't parse the HAR/Burp
-- content — that's the engine's job. We only persist the references
-- and place the bytes where the engine can find them.
--
-- Storage layout:
--   user-uploads/<org_id>/scan-imports/<random_id>/<filename>
-- Files are uploaded by the user-context client (RLS is the
-- migration-001 "members upload user files" policy), so a member of
-- one org cannot stage an import into another org's prefix.
--
-- The reference shape is JSONB-as-array; small enough to keep on the
-- scan row and avoids a separate table for what is at most 5 entries
-- per scan.

alter table public.scans
  add column if not exists imports jsonb;

-- Each entry shape (loosely typed, validated by the API route's zod
-- schema and again by the worker before download):
--   { "kind": "har" | "burp",
--     "storage_path": "<org_id>/scan-imports/<rand>/<filename>",
--     "filename": "burp-export-2026-05-12.xml",
--     "size_bytes": 1247503 }

-- Bump create_scan_with_targets to a 14-arg signature with imports as
-- the new optional last positional. Drop the prior 13-arg overload to
-- avoid PGRST203 ambiguity (same pattern as 026 / 033 / 034).

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
  p_max_input_tokens integer default null,
  p_imports         jsonb default null
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
  v_import jsonb;
  v_path text;
begin
  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    raise exception 'at least one target required';
  end if;

  -- Defence in depth: every import's storage_path must start with
  -- this org's UUID. Belt-and-braces against an API caller passing
  -- a forged storage_path that points at another org's prefix; the
  -- storage RLS already prevents cross-org reads but the worker uses
  -- a service-role client to download, so we re-check the prefix
  -- in SQL where it's enforced regardless of the caller.
  if p_imports is not null and jsonb_typeof(p_imports) = 'array' then
    for v_import in select jsonb_array_elements(p_imports)
    loop
      v_path := v_import->>'storage_path';
      if v_path is null or v_path = ''
        or split_part(v_path, '/', 1) <> p_org_id::text
      then
        raise exception 'import storage_path must start with org_id: %', v_path;
      end if;
    end loop;
  end if;

  insert into public.scans (
    org_id, user_id, target_id, run_name, status, scan_mode, scope_mode,
    diff_base, instruction_text, dns_only, branch, max_cost, max_input_tokens,
    imports
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text, coalesce(p_dns_only, false),
    nullif(trim(p_branch), ''),
    case when p_max_cost is not null and p_max_cost > 0 then p_max_cost else null end,
    case when p_max_input_tokens is not null and p_max_input_tokens > 0 then p_max_input_tokens else null end,
    case when p_imports is not null and jsonb_typeof(p_imports) = 'array' and jsonb_array_length(p_imports) > 0
         then p_imports else null end
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
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer
);

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer, jsonb
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer, jsonb
) to authenticated, service_role;
