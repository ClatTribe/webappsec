-- Tier II #7 — GitHub PR comment bot.
--
-- The biggest "closes the daily-touch gap" feature in the wrapper:
-- when a dev opens a PR, TensorShield runs a diff-mode scan and
-- posts a sticky comment summarising findings inline on the PR
-- itself. The dev does not have to visit our dashboard for routine
-- triage — meeting the developer where they already work.
--
-- This migration adds two clusters of columns on `scans`:
--
-- 1. PR context (set at scan creation via the webhook receiver):
--    - github_pull_request_number   the PR # we're commenting on
--    - github_owner / github_repo    parsed once, denormalised so
--                                    the worker doesn't re-parse
--                                    every poll
--    - github_head_sha               the head SHA we scanned, so
--                                    the comment can deeplink to
--                                    the right commit and re-runs
--                                    on the next sync can detect
--                                    "still same SHA, skip"
--
-- 2. Sticky-comment tracking (set after first /pr-comment POST):
--    - pr_comment_id                 GitHub comment id; PATCH on
--                                    re-run, not POST. We want one
--                                    comment per PR that updates,
--                                    not N comments per push.
--    - pr_comment_url                permalink for the UI to deep
--                                    -link from scan-detail
--    - pr_comment_posted_at          first-post timestamp
--    - pr_comment_updated_at         last-update timestamp
--
-- We do NOT add a separate `pr_comments` history table — the sticky
-- comment is the canonical record on GitHub's side; the wrapper
-- tracks only "the comment we own for this scan." If we want a
-- history later (multiple scans per PR over time), that's a
-- separate roll-up at the PR-number granularity.

alter table public.scans
  add column if not exists github_pull_request_number integer,
  add column if not exists github_owner text,
  add column if not exists github_repo text,
  add column if not exists github_head_sha text,
  add column if not exists pr_comment_id bigint,
  add column if not exists pr_comment_url text,
  add column if not exists pr_comment_posted_at timestamptz,
  add column if not exists pr_comment_updated_at timestamptz;

-- Find-all-scans-for-this-PR query gets used both from the worker
-- (when deciding whether this is a re-run) and the UI ("which
-- scans for this PR?"). Index supports both — partial because the
-- vast majority of scans are NOT PR-driven.
create index if not exists scans_github_pr
  on public.scans (org_id, github_owner, github_repo, github_pull_request_number)
  where github_pull_request_number is not null;

comment on column public.scans.github_pull_request_number is
  'Tier II #7 — PR # this scan was triggered for via the GitHub webhook. '
  'Drives the sticky-comment posting after finalize. Null for manually '
  'kicked scans even if they happen to be on a repo with PR integration.';

comment on column public.scans.pr_comment_id is
  'Tier II #7 — GitHub comment id of the sticky comment we own for this '
  'PR. Set by /api/scans/[id]/pr-comment on first POST; reused as a PATCH '
  'target on subsequent re-runs so there is one running comment per PR, '
  'not N per push.';

-- ============================================================================
-- GitHub webhook secret — per-integration, stored verbatim in metadata.
-- We use the metadata JSONB rather than a separate vault entry because:
--   (a) the secret is an HMAC key, not a long-term credential;
--   (b) it is set when the user configures the webhook on GitHub's side,
--       displayed once, then verified per request via constant-time HMAC.
-- Anyone with access to `integrations.metadata` for this org already has
-- access to the scan results — there's nothing weaker about putting the
-- HMAC key here vs the vault. The vault would just add a round-trip per
-- webhook delivery.
-- ============================================================================

-- No DDL needed — `integrations.metadata` is JSONB. Convention:
--   integrations.metadata.webhook_secret  text  (per-integration HMAC key)
--   integrations.metadata.repo_full_name  text  ("owner/repo", for routing)
-- This comment block documents the convention so future readers don't
-- bolt a separate column on.

-- ============================================================================
-- Worker → wrapper post-finalize hook authentication.
--
-- The worker has historically only written SQL — no HTTP back to the
-- wrapper. Tier II #7 introduces a single HTTP callback: after
-- finish_scan(), if the scan has PR context, the worker POSTs to
-- /api/internal/scans/[id]/finalize-post-actions which (a) posts the
-- sticky comment, and later (b) uploads SARIF.
--
-- The callback is authenticated via a shared secret in
-- `tensorshield_settings.worker_internal_secret`. We store it in the
-- DB rather than a Next.js env var so both sides (worker via supabase
-- client, frontend via service-role admin) read the same value at
-- runtime. Service-role only — RLS denies all anon/auth reads.
-- ============================================================================

create table if not exists public.tensorshield_settings (
  id smallint primary key default 1 check (id = 1),  -- singleton row
  worker_internal_secret text,
  updated_at timestamptz not null default now()
);

-- Seed the singleton row with a cryptographically random secret on
-- first migration. Re-running the migration is idempotent: the
-- on-conflict-do-nothing leaves an existing secret untouched.
insert into public.tensorshield_settings (id, worker_internal_secret)
values (1, encode(gen_random_bytes(32), 'base64'))
on conflict (id) do nothing;

alter table public.tensorshield_settings enable row level security;

-- No SELECT/INSERT/UPDATE policies — only service-role can read this
-- table. RLS denies all authenticated/anon access by default when no
-- permissive policy exists.

comment on table public.tensorshield_settings is
  'Tier II #7 — singleton row holding cross-service secrets. Currently '
  'just the worker_internal_secret used to authenticate worker → wrapper '
  'HTTP callbacks. Service-role only; RLS denies all anon/auth access.';
