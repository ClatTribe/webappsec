-- Bug fix surfaced by Tier 0 / Tier A e2e evaluation against
-- getedunext.com (run #7 + run #8). Two real-world standard-mode scans
-- spent $0.88 + 2.5 hours wall-clock and produced 0 findings — but
-- coverage.json reported `coverage_percent: 0.0` and
-- `status: "incomplete"` (none of the required CSRF / IDOR /
-- open_redirect / SQLi / SSRF / XSS checks ran).
--
-- The wrapper rendered `vendor_risk: 100/100 low_risk` and
-- `summary_text: "...with no findings"` in spite of that — which is
-- misleading. A pentest customer reading the report would think the
-- site was thoroughly tested and clean. In reality the agent stopped
-- at recon. The "trust gap" between what's plumbed and what's
-- executed is the most important UX issue the wrapper has today.
--
-- This migration adds `scans.coverage` JSONB so the worker can
-- persist the engine's `coverage.json` artifact verbatim. The UI then
-- renders an amber "coverage incomplete" banner whenever
-- `status="incomplete"` so the operator can't miss it. Same JSONB-blob
-- pattern as `scans.run_meta` (migration 031) — adding a future
-- coverage signal is a UI change, not a schema change.
--
-- Per Architecture.md §1.1: the engine writes coverage.json, the
-- wrapper persists + renders verbatim. We don't recompute coverage
-- percentages or reclassify gaps client-side.

alter table public.scans
  add column if not exists coverage jsonb;

create or replace function public.worker_set_coverage(
  p_scan_id uuid,
  p_coverage jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_set_coverage requires service role';
  end if;
  update public.scans set coverage = p_coverage where id = p_scan_id;
end;
$$;

revoke execute on function public.worker_set_coverage(uuid, jsonb)
  from public, anon, authenticated;
grant   execute on function public.worker_set_coverage(uuid, jsonb)
  to service_role;
