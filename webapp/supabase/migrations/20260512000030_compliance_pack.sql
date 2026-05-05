-- §19.4 Tier 4 row 1 — auditor-grade compliance evidence pack download.
--
-- Engine PR #129 ships `--compliance-pack <tmp>` which writes an 8-file
-- auditor bundle to `<tmp>/<run_id>/` (manifest, control_attestation,
-- coverage_attestation, findings.csv, events.jsonl excerpt + signature,
-- run_meta.json, and a SHA256SUMS over them all). The bundle is the
-- single biggest B2B-sale unlock per the wishlist — auditors hand it
-- to compliance teams as "evidence the engine actually ran."
--
-- The wrapper's job:
--   1. Pass the flag to strix on every scan (worker change).
--   2. Upload the resulting bundle to scan-artifacts storage at
--      `<org_id>/<scan_id>/compliance_pack/...` after the run.
--   3. Flip a boolean on `scans` so the UI knows whether to render the
--      "Download compliance pack" button without a storage list call.
--
-- Per Architecture.md §1.1 — the engine writes the bundle, the wrapper
-- ships it. We don't re-derive control_attestation or manifest content;
-- we forward the engine artifacts verbatim.

alter table public.scans
  add column if not exists compliance_pack_uploaded boolean not null default false;

-- ============== Worker flip RPC ==============
--
-- Service-role-only mutator. Worker calls after the upload step lands
-- at least one file in storage. SECURITY DEFINER scopes the write to a
-- single boolean on a single row; pairs with the existing
-- worker_set_preflight_failed pattern (migration 029).

create or replace function public.worker_set_compliance_pack_uploaded(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_set_compliance_pack_uploaded requires service role';
  end if;
  update public.scans set compliance_pack_uploaded = true where id = p_scan_id;
end;
$$;

revoke execute on function public.worker_set_compliance_pack_uploaded(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_set_compliance_pack_uploaded(uuid)
  to service_role;
