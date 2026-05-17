-- Extend public.targets toward the per-org asset registry shape from
-- AISecurityEngineerUXRoadmap.md §13.0.
--
-- Today's public.targets (migration 011) already gives us "one row per asset,
-- unique per (org_id, value)" with RLS keyed to org_id. That's the registry
-- substrate — and it deliberately is the place every other phase (chat
-- digests, continuous-scan daemon, trust pages, autonomy slider) reads from.
--
-- What was missing for those downstream phases:
--
--   1. `schedule jsonb` — the existing `scan_frequency` enum is too coarse.
--      The platform needs to express on-push (for repo assets), daily-at-time
--      (for web-app DAST), cron expressions, and per-asset overrides. We
--      keep `scan_frequency` for backward compat; new code reads from
--      `schedule` first and falls back.
--
--   2. `posture jsonb` — a denormalised summary
--      `{critical, high, medium, low, info, coverage_percent,
--       last_scan_status, last_scan_at}`. The chat agent's daily digest
--      and the asset-inventory view both want this without joining to
--      `findings` + `scan_coverage` every read. Maintained by the worker
--      at scan-end (separate PR; this migration just creates the column).
--
--   3. `archived_at timestamptz` — replaces the boolean nature of
--      `status='archived'` with a timestamp for retention queries + audit.
--      We keep `status` as the canonical write surface for now (frontend
--      types depend on it) and sync `archived_at` via trigger. The unique
--      constraint stays on (org_id, value) — relaxing it to allow
--      re-registration after archive is a separate change that needs to
--      coordinate with the `ensure_target_for_scan` upsert path.
--
-- This migration is strictly additive: no existing reads or writes break.
-- The frontend `Target` row type gains three optional fields.

alter table public.targets
  add column if not exists schedule    jsonb,
  add column if not exists posture     jsonb,
  add column if not exists archived_at timestamptz;

comment on column public.targets.schedule is
  'Per-asset scan schedule. Examples: {"kind":"daily","time":"03:00Z"}, '
  '{"kind":"on_push"}, {"kind":"cron","expr":"0 */6 * * *"}. NULL means '
  'fall back to scan_frequency.';

comment on column public.targets.posture is
  'Denormalised summary of the latest scan against this asset. Maintained '
  'by the worker at scan-end. Shape: {critical,high,medium,low,info,'
  'coverage_percent,last_scan_status,last_scan_at}. NULL until first scan.';

comment on column public.targets.archived_at is
  'Set when status transitions to archived; null when active. Maintained by '
  'trigger targets_sync_archived_at_trg.';

-- Backfill: every existing archived row gets an archived_at timestamp so
-- retention queries are immediately accurate.
update public.targets
   set archived_at = coalesce(last_scan_at, created_at, now())
 where status = 'archived' and archived_at is null;

-- Trigger: keep archived_at in sync with status transitions.
create or replace function public.targets_sync_archived_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'archived' and new.archived_at is null then
      new.archived_at := now();
    end if;
    return new;
  end if;

  -- UPDATE path
  if new.status = 'archived' and old.status is distinct from 'archived' then
    new.archived_at := coalesce(new.archived_at, now());
  elsif new.status = 'active' and old.status is distinct from 'active' then
    new.archived_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists targets_sync_archived_at_ins on public.targets;
create trigger targets_sync_archived_at_ins
  before insert on public.targets
  for each row execute function public.targets_sync_archived_at();

drop trigger if exists targets_sync_archived_at_upd on public.targets;
create trigger targets_sync_archived_at_upd
  before update of status on public.targets
  for each row execute function public.targets_sync_archived_at();

-- Index: speed up "list active assets for org" reads, which the chat
-- agent's daily digest does on every turn.
create index if not exists targets_org_active
  on public.targets (org_id, last_scan_at desc)
  where status = 'active';
