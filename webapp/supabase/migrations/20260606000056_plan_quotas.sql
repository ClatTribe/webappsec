-- Per-tier scan quota + cost cap defaults — cost-reduction quick win.
--
-- The pricing page promises:
--   Free      5 scans / month, no specified $-cap (we default to $0.50)
--   Team     100 scans / month, $2.50 per scan
--   Business unlimited,         $10.00 per scan
--
-- None of this is enforced today. A free-tier user can run 5,000 scans
-- this month and burn the shared inference budget. This migration ships:
--
--   1. plan_quotas reference table — single source of truth.
--   2. enforce_org_scan_quota(org_id) RPC — atomically counts the
--      org's current-month scans and returns (allowed, current, limit,
--      plan, default_max_cost). API routes call this before insert.
--   3. org_monthly_scan_count(org_id) helper view for the settings UI
--      to display usage.
--
-- The wrapper-side enforcement is the gate; the engine's own
-- --max-cost self-exit (engine PR #113) is the second line of defence
-- if a scan slips past quota.

-- ============== REFERENCE TABLE ==============

create table if not exists public.plan_quotas (
  plan             text primary key check (plan in ('free','pro','enterprise')),
  monthly_scans    int,                       -- null = unlimited
  default_max_cost numeric not null,           -- $ per scan
  description      text
);

-- Seed / upsert. Idempotent.
insert into public.plan_quotas (plan, monthly_scans, default_max_cost, description)
values
  ('free',         5,    0.50, 'Free — 5 scans/month, $0.50 cap per scan'),
  ('pro',          100,  2.50, 'Team — 100 scans/month, $2.50 cap per scan'),
  ('enterprise',   null, 10.00,'Business — unlimited scans, $10.00 cap per scan')
on conflict (plan) do update set
  monthly_scans    = excluded.monthly_scans,
  default_max_cost = excluded.default_max_cost,
  description      = excluded.description;

-- Public read so the pricing page + settings page can display
-- current quotas without elevated perms. Quotas are not secrets.
alter table public.plan_quotas enable row level security;
drop policy if exists plan_quotas_public_read on public.plan_quotas;
create policy plan_quotas_public_read on public.plan_quotas
  for select to authenticated, anon
  using (true);

-- ============== USAGE VIEW ==============

create or replace view public.org_monthly_scan_usage_v as
select
  o.id as org_id,
  o.plan,
  q.monthly_scans,
  q.default_max_cost,
  (
    select count(*)
    from public.scans s
    where s.org_id = o.id
      and s.created_at >= date_trunc('month', now())
  ) as scans_this_month
from public.organizations o
left join public.plan_quotas q on q.plan = o.plan;

comment on view public.org_monthly_scan_usage_v is
  'Per-org current-month scan count + plan limit + default cost cap. '
  'Inherits RLS from organizations + scans so each org sees only its own row.';

-- ============== QUOTA ENFORCEMENT RPC ==============
-- Called by the scan-create API route BEFORE inserting a new scan.
-- Returns:
--   allowed         — whether the next scan would fit under the quota
--   current_count   — scans this org has already run this month
--   limit_value     — monthly_scans from plan_quotas, or null = unlimited
--   plan            — the org's plan
--   default_max_cost — $/scan cap to apply when caller doesn't specify

create or replace function public.enforce_org_scan_quota(
  p_org_id uuid
)
returns table (
  allowed          boolean,
  current_count    int,
  limit_value      int,
  plan             text,
  default_max_cost numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with usage as (
    select * from public.org_monthly_scan_usage_v where org_id = p_org_id
  )
  select
    case
      when u.monthly_scans is null then true                     -- enterprise / unlimited
      when u.scans_this_month < u.monthly_scans then true
      else false
    end                                                          as allowed,
    coalesce(u.scans_this_month, 0)::int                          as current_count,
    u.monthly_scans                                               as limit_value,
    coalesce(u.plan, 'free')                                      as plan,
    coalesce(u.default_max_cost, 0.50)                            as default_max_cost
  from usage u;
$$;

revoke execute on function public.enforce_org_scan_quota(uuid) from public, anon;
grant   execute on function public.enforce_org_scan_quota(uuid)
  to authenticated, service_role;

comment on function public.enforce_org_scan_quota(uuid) is
  'Returns whether the next scan fits the org''s monthly quota + the '
  'plan-default per-scan cost cap. API routes call this before insert. '
  'STABLE — does not mutate; the actual insert is the gate.';
