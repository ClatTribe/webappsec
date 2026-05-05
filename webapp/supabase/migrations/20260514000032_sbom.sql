-- §19.4 Tier 4 row 3 — SBOM (Software Bill of Materials) viewer.
--
-- Engine PR #131 writes `<run_dir>/sbom.cdx.json` (CycloneDX 1.5)
-- listing every component the engine fingerprinted on the target —
-- name, version, purl, type, detected_via, confidence. The worker's
-- existing _upload_run_artifacts loop already lands the file in
-- scan-artifacts at `<org>/<scan>/sbom.cdx.json`.
--
-- The wrapper's job is small:
--   1. A boolean on the scan row so the UI knows whether to render
--      the SBOM CTAs without a per-page-load storage probe.
--   2. A scoped service-role mutator to flip it.
--   3. The API route + UI consume the storage file directly.
--
-- Same scoped-mutator pattern as worker_set_preflight_failed (029)
-- and worker_set_compliance_pack_uploaded (030).

alter table public.scans
  add column if not exists sbom_uploaded boolean not null default false;

create or replace function public.worker_set_sbom_uploaded(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_set_sbom_uploaded requires service role';
  end if;
  update public.scans set sbom_uploaded = true where id = p_scan_id;
end;
$$;

revoke execute on function public.worker_set_sbom_uploaded(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_set_sbom_uploaded(uuid)
  to service_role;
