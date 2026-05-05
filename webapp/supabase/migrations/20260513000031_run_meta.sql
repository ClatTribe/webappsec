-- §19.4 Tier 4 rows 2 + 4 — vendor-risk gauge + MFA-posture badge.
--
-- Engine PR #103 / #132 / #133 land structured signals in
-- `<run_dir>/run_meta.json` that the scan-page hero needs to render:
--
--   run_meta.vendor_risk            — engine PR #133 (always present
--                                     even without --vendor-mode)
--   run_meta.mfa_attestation        — engine PR #132 (per-target or
--                                     top-level depending on shape)
--   run_meta.compliance_posture     — engine PR #103 (cadence status)
--
-- Rather than a column per signal — which forces a migration every
-- time the engine adds a new top-level key — we persist run_meta as
-- a single JSONB blob. The wrapper UI reads typed paths into it (see
-- `Scan.run_meta` in lib/supabase/types.ts). This matches the
-- `scans.summary` pattern (migration 022) and `findings.trajectory`
-- (migration 029) — Architecture.md §1.1: engine is source of truth,
-- wrapper persists structured artifacts verbatim.

alter table public.scans
  add column if not exists run_meta jsonb;

-- ============== Worker writeback RPC ==============
--
-- Service-role-only. Called by the worker once per scan, after
-- `_upload_run_artifacts` reads the file from disk. SECURITY DEFINER
-- scopes the write to a single row; pairs with the existing
-- worker_set_preflight_failed (029) and worker_set_compliance_pack_uploaded
-- (030) patterns.

create or replace function public.worker_set_run_meta(
  p_scan_id uuid,
  p_run_meta jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_set_run_meta requires service role';
  end if;
  update public.scans set run_meta = p_run_meta where id = p_scan_id;
end;
$$;

revoke execute on function public.worker_set_run_meta(uuid, jsonb)
  from public, anon, authenticated;
grant   execute on function public.worker_set_run_meta(uuid, jsonb)
  to service_role;
