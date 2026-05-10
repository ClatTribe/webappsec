-- Per-org chat rate limit — AISecurityEngineerUXRoadmap.md §13.10
-- Phase G substrate.
--
-- For a multi-tenant SaaS endpoint serving thousands of orgs, the
-- chat-handler endpoint /api/chat/process-message is a meaningful cost
-- vector — each call may eventually invoke inference. Without limits,
-- one runaway client (intentional or otherwise) could drain shared
-- infrastructure budget for everyone.
--
-- v1: fixed-window counter, per-org, per-minute. SECURITY DEFINER
-- function the API route calls to atomically check + increment. Counts
-- live in chat_rate_limits keyed on (org_id, window_start).
--
-- v2 (future) adds:
--   - Sliding-window for smoother behaviour
--   - Per-tier limits read from organizations.plan
--   - Inference-token budget tracking (not just call count)
--   - GraphQL-style query-cost weighting

create table if not exists public.chat_rate_limits (
  org_id        uuid not null references public.organizations on delete cascade,
  window_start  timestamptz not null,
  call_count    int not null default 0,
  primary key (org_id, window_start)
);

create index if not exists chat_rate_limits_recent
  on public.chat_rate_limits (org_id, window_start desc);

comment on table public.chat_rate_limits is
  'Per-org fixed-window (1 minute) counter for chat-handler calls. '
  'Cleared by retention sweep; rate-limit decision is point-in-time.';

alter table public.chat_rate_limits enable row level security;

-- No direct user reads. The org sees its own rate-limit state via the
-- API response when denied; raw row reads aren't useful.

-- Service-role function: increment the current window, return whether
-- the call is allowed. The atomicity is the point — without it two
-- concurrent calls could each read N below the limit and both proceed,
-- ending up at N+2.

create or replace function public.enforce_chat_rate_limit(
  p_org_id       uuid,
  p_limit_per_min int default 60
)
returns table (
  allowed         boolean,
  current_count   int,
  limit_value     int,
  window_started  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count  int;
begin
  if auth.role() not in ('service_role') then
    raise exception 'enforce_chat_rate_limit requires service role';
  end if;

  -- Truncate now() to the minute. All calls in the same wall-clock
  -- minute share a row.
  v_window := date_trunc('minute', now());

  -- Upsert + return the new count atomically. The increment is the
  -- INSERT...ON CONFLICT DO UPDATE pattern — single statement, no
  -- read-modify-write race. Table column is fully qualified (rather
  -- than via the on-conflict shorthand) so the OUT parameter
  -- `window_started` of the wrapper function isn't ambiguous with
  -- chat_rate_limits.window_start.
  insert into public.chat_rate_limits as crl (org_id, window_start, call_count)
  values (p_org_id, v_window, 1)
  on conflict (org_id, window_start) do update
    set call_count = crl.call_count + 1
  returning crl.call_count into v_count;

  return query select
    v_count <= p_limit_per_min as allowed,
    v_count                    as current_count,
    p_limit_per_min            as limit_value,
    v_window                   as window_started;
end;
$$;

revoke execute on function public.enforce_chat_rate_limit(uuid, int)
  from public, anon, authenticated;
grant   execute on function public.enforce_chat_rate_limit(uuid, int)
  to service_role;

comment on function public.enforce_chat_rate_limit(uuid, int) is
  'Atomically increment the per-org per-minute chat-call counter + '
  'return whether the call is allowed. Service-role only. Returns '
  'current_count + limit + window_start so the API route can shape '
  'a useful Retry-After response.';

-- ============== RETENTION SWEEP ==============
-- Counters older than 24h are dead weight — no decision is ever made
-- against them. A periodic delete keeps the table tiny.

create or replace function public.sweep_chat_rate_limits()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if auth.role() not in ('service_role') then
    raise exception 'sweep_chat_rate_limits requires service role';
  end if;

  with deleted as (
    delete from public.chat_rate_limits
    where window_start < now() - interval '24 hours'
    returning 1
  )
  select count(*) into v_n from deleted;
  return v_n;
end;
$$;

revoke execute on function public.sweep_chat_rate_limits()
  from public, anon, authenticated;
grant   execute on function public.sweep_chat_rate_limits()
  to service_role;
