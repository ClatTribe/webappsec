-- Tier II #9 — Onboarding wizard state.
--
-- A skippable wizard that meets the user the moment they log in for the
-- first time: detects stack from their GitHub repos, suggests an
-- initial scan target, and gets them to a green path before the
-- empty-dashboard staring contest sets in.
--
-- This migration adds the minimum state to track "should we show the
-- dialog?" per user:
--
--   - profiles.onboarding_state              text     (state machine — pending/in_progress/completed/dismissed)
--   - profiles.onboarding_dismissed_at       timestamptz  (when the user clicked Skip)
--   - profiles.onboarding_completed_at       timestamptz  (when the user finished the wizard)
--
-- We backfill `completed` for any profile whose org already has a scan
-- (these are existing users — showing them a "welcome" wizard would be
-- jarring and useless). New signups get `pending` by default.
--
-- The state lives on `profiles` rather than `org_members` because
-- onboarding is a per-user UI concern, not a per-org permission concern.
-- Two co-founders in the same org each see (or don't see) the wizard
-- based on their own state.

alter table public.profiles
  add column if not exists onboarding_state text not null default 'pending'
    check (onboarding_state in ('pending', 'in_progress', 'completed', 'dismissed')),
  add column if not exists onboarding_dismissed_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.profiles.onboarding_state is
  'Tier II #9 — onboarding wizard state. ''pending'' on new signup. '
  'Flipped to ''in_progress'' the moment the user clicks "Detect my stack" '
  'so a page reload mid-wizard does not reset progress. ''completed'' / '
  '''dismissed'' both stop the dialog from rendering.';

-- Backfill: any profile whose user_id appears as a scan creator gets
-- marked completed. We use a left-join existence check rather than a
-- bare EXISTS so the update is set-based (single statement instead of
-- per-row trigger) and the planner can use the (user_id) index on scans.
update public.profiles p
   set onboarding_state = 'completed',
       onboarding_completed_at = now()
  from (
    select distinct user_id from public.scans
  ) s
 where p.id = s.user_id
   and p.onboarding_state = 'pending';

-- Idempotent: re-running the migration after we've already backfilled
-- won't double-stamp because the WHERE clause only matches profiles
-- still in the 'pending' state.

-- ============================================================================
-- Lightweight RPC: returns the canonical onboarding state for the
-- current user. Used by the app shell to decide whether to render the
-- dialog. Service-role / RLS-safe — invoker security so the user's own
-- profile row is returned (RLS lets you select your own profile).
-- ============================================================================

create or replace function public.my_onboarding_state()
returns text
language sql
security invoker
set search_path = public
as $$
  select onboarding_state from public.profiles where id = auth.uid();
$$;

grant execute on function public.my_onboarding_state() to authenticated;

comment on function public.my_onboarding_state() is
  'Tier II #9 — returns the current user''s onboarding state. Wrapper '
  'around a select-from-profiles so the app shell can fetch it in one '
  'round-trip without needing a typed profile read.';
