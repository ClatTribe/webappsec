-- Patcher → PR flow (closing the find-fix loop).
--
-- When a user clicks "Apply as PR" on a finding card's suggested fix,
-- the wrapper:
--   1. Resolves the org's `github` integration + decrypts the token
--   2. Parses the engine's unified diff
--   3. Applies it via the GitHub Git Data API (blob → tree → commit)
--   4. Opens a PR referencing the finding
--   5. Writes the PR URL back here so the UI shows "View PR" on revisit
--
-- Two columns:
--   patch_pr_url    — the GitHub PR HTML URL after creation. NULL while
--                     the engine has proposed the patch but the user
--                     hasn't applied it yet.
--   patch_applied_at — wall-clock timestamp the wrapper opened the PR.
--                     Distinct from patch_proposed_at (engine writes
--                     that when the Patcher specialist drafts the diff)
--                     and patch_verified_at (engine writes that when
--                     auto_verify_patch confirms the fix closed the
--                     finding via probe re-run).
--
-- Columns are nullable + additive — older findings still render fine,
-- and the API route only touches the row when the apply flow succeeds.

alter table public.findings
  add column if not exists patch_pr_url text,
  add column if not exists patch_applied_at timestamptz;

comment on column public.findings.patch_pr_url is
  'GitHub PR URL the wrapper opened when the user applied the engine-'
  'proposed patch. Wrapper-authored at apply-time; never set by the '
  'engine. Renders the "View PR" link on the finding card.';

create index if not exists findings_patch_pr
  on public.findings (org_id, patch_applied_at desc)
  where patch_pr_url is not null;
