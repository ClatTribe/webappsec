-- Phase B #7 — risk-acceptance flow on findings.
--
-- Today a finding marked `wont_fix` is just a tombstone — no reason,
-- no expiry, no auditor-grade story. That's fine for true won't-fixes
-- but it conflates them with "accepted risk, time-boxed exception."
-- Real security teams need the latter to be trackable: who accepted,
-- why, when does the acceptance lapse.
--
-- Two columns:
--   wont_fix_reason            — free-text rationale required when a
--                                user marks a finding `wont_fix`. The
--                                triage dialog gates the action on a
--                                non-empty value.
--   risk_acceptance_expires_at — optional. When set, the dashboard
--                                renders "X days until expiry" and a
--                                worker tick (future) can auto-reopen
--                                the finding at the deadline.
--
-- Both columns are nullable — historical wont_fix rows that pre-date
-- this migration stay untouched; only new triage actions require the
-- reason.

alter table public.findings
  add column if not exists wont_fix_reason text,
  add column if not exists risk_acceptance_expires_at timestamptz;

-- Index on (org_id, expires_at) so the "expiring soon" dashboard
-- card can fetch in one round-trip without a sequential scan.
create index if not exists findings_risk_acceptance_expiry
  on public.findings (org_id, risk_acceptance_expires_at)
  where risk_acceptance_expires_at is not null;

comment on column public.findings.wont_fix_reason is
  'Phase B #7 — required free-text rationale when a user marks the '
  'finding wont_fix. The triage dialog gates the action; auditor-'
  'grade evidence stays attached to the finding itself.';

comment on column public.findings.risk_acceptance_expires_at is
  'Phase B #7 — optional expiry on a wont_fix decision. When set, '
  'the finding becomes "accepted risk with a deadline" rather than '
  'a permanent dismissal. The dashboard surfaces expiring exceptions.';
