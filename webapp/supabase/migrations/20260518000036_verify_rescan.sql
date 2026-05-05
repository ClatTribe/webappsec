-- Tier A — fix-verify targeted rescan (wishlist §9.3 row 2).
--
-- Closes the engineer's "I fixed it; verify" loop. From a finding's
-- casefile, the operator clicks "Re-scan to verify fix". The wrapper
-- creates a new narrow scan with focused instruction text, links it
-- back to the original finding via `scans.verifying_finding_id`, and
-- surfaces "Verifying finding: <title>" on the new scan's page.
--
-- We don't extend create_scan_with_targets to a 15-arg overload here —
-- the API route uses an admin-client UPDATE to set the column after
-- the RPC creates the scan. Avoids yet another PGRST203 dance and
-- keeps the scan-create RPC focused on its core responsibility.
--
-- The auto-flip-to-fixed behaviour (when the verify scan finishes
-- with the original fingerprint absent) is a deliberate follow-up.
-- For this MVP the operator manually triages the result — same as
-- any other re-scan.

alter table public.scans
  add column if not exists verifying_finding_id uuid
    references public.findings(id) on delete set null;

-- Lookup index: "show me all scans that verified this finding" — used
-- by the FindingCard's verification history row in a future PR.
create index if not exists scans_verifying_finding_id_idx
  on public.scans (verifying_finding_id)
  where verifying_finding_id is not null;
