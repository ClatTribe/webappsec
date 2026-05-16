-- Phase A #5 — SARIF upload to GitHub Code Scanning.
--
-- The engine writes one SARIF artefact per `scan_sast(sarif_output_path=...)`
-- invocation. When a repository target is bound to a GitHub integration
-- (migration 061 added `targets.integration_id`), the worker can push
-- that SARIF to the repo's Code Scanning surface via the GitHub API —
-- giving developers inline findings on PR diffs without leaving GitHub.
--
-- Two columns + an index for the "scans needing SARIF re-upload" filter:
--   code_scanning_url       — the resulting GitHub UI URL after a
--                             successful upload (typically
--                             `https://github.com/<o>/<r>/security/
--                             code-scanning?query=is:open+...`).
--                             NULL until the worker uploads.
--   code_scanning_uploaded_at — when the upload landed. Distinct from
--                             scan finished_at because the upload
--                             happens at finalize but may race the
--                             status flip.
--
-- Best-effort: if upload fails (no integration, non-GitHub host, API
-- error), both columns stay NULL and the wrapper UI hides the link.

alter table public.scans
  add column if not exists code_scanning_url text,
  add column if not exists code_scanning_uploaded_at timestamptz;

create index if not exists scans_code_scanning_uploaded
  on public.scans (org_id, code_scanning_uploaded_at desc)
  where code_scanning_url is not null;

comment on column public.scans.code_scanning_url is
  'GitHub Code Scanning URL after a successful SARIF upload. Worker '
  'writes this at scan-finalize when the parent target is a repository '
  'bound to a GitHub integration (migration 061). NULL means the '
  'upload was skipped or failed.';
