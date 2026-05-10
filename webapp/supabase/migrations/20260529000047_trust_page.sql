-- Public Living Trust Page — AISecurityEngineerUXRoadmap.md §10 Phase H
-- (delivered as part of Phase C because the data plumbing comes from
-- compliance_evidence — Phase H itself is the custom-domain + agent-
-- narrative iteration).
--
-- A public URL — `/trust/<org-slug>` — that prospects, auditors, and
-- partners can bookmark. Updates in real time from each scan. The org
-- explicitly opts in via organizations.trust_page_enabled; default is
-- false so no org has their posture exposed unintentionally.
--
-- Security model:
--
--   The trust page is read by ANONYMOUS clients (no auth). RLS on
--   organizations / compliance_evidence would deny anonymous reads,
--   which is correct as a defence-in-depth. We expose a single
--   SECURITY DEFINER function get_trust_page_payload(slug) that:
--     1. Resolves the slug to an org.
--     2. CHECKS trust_page_enabled — denies if false.
--     3. Returns a curated public payload (no team info, no scan
--        budgets, no internal IDs beyond the org/scan reference).
--
--   This is the only path anonymous traffic can read compliance
--   evidence — the function's restriction is the security boundary.

alter table public.organizations
  add column if not exists trust_page_enabled    boolean not null default false,
  add column if not exists trust_page_published_at timestamptz,
  add column if not exists trust_page_subtitle   text;

comment on column public.organizations.trust_page_enabled is
  'When true, /trust/<slug> is publicly accessible and renders this '
  'org''s compliance posture + recent improvements. Default false — '
  'no org has their posture exposed without explicit opt-in.';

-- Trigger keeps trust_page_published_at in sync with the toggle.
create or replace function public.organizations_sync_trust_published_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.trust_page_enabled and old.trust_page_enabled is distinct from true then
      new.trust_page_published_at := coalesce(new.trust_page_published_at, now());
    elsif not new.trust_page_enabled and old.trust_page_enabled then
      -- Keep published_at on disable so "page enabled since X (now disabled)"
      -- audit trails are preserved. Re-enable doesn't reset.
      null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_sync_trust_published_at_trg on public.organizations;
create trigger organizations_sync_trust_published_at_trg
  before update of trust_page_enabled on public.organizations
  for each row execute function public.organizations_sync_trust_published_at();

-- ============== PUBLIC PAYLOAD FUNCTION ==============
-- Curated read for anonymous traffic. The function is the only public
-- entry point — direct table reads are RLS-denied.

create or replace function public.get_trust_page_payload(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_org    record;
  v_postures jsonb;
  v_stats    jsonb;
  v_recent_resolved jsonb;
begin
  -- Step 1: resolve slug + check publication gate. Single query.
  select
    o.id, o.name, o.slug, o.plan,
    o.trust_page_enabled,
    o.trust_page_subtitle,
    o.trust_page_published_at,
    o.created_at
  into v_org
  from public.organizations o
  where o.slug = p_slug
    and o.trust_page_enabled = true
  limit 1;

  if v_org.id is null then
    return null;  -- caller renders 404
  end if;

  -- Step 2: framework readiness. Group by framework, compute per-framework
  -- counters from the latest-verdict view.
  with per_fw as (
    select
      framework,
      count(*) filter (where verdict = 'pass')::int                       as passing,
      count(*) filter (where verdict = 'fail')::int                       as failing,
      count(*) filter (where verdict = 'warn')::int                       as warning,
      count(*) filter (where verdict in ('untested','info'))::int         as untested,
      count(*)::int                                                       as total
    from public.org_compliance_posture_v
    where org_id = v_org.id
    group by framework
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'framework',     framework,
      'total',         total,
      'passing',       passing,
      'failing',       failing,
      'warning',       warning,
      'untested',      untested,
      'readiness_pct',
        case when total - untested = 0 then 0
        else round(100.0 * passing / nullif(total - untested, 0), 1) end
    )
    order by framework
  ), '[]'::jsonb)
  into v_postures
  from per_fw;

  -- Step 3: high-level finding stats (last 30 days) — fix/dismiss counts,
  -- recent KEV-fix turnaround. Numbers only; no titles.
  with recent as (
    select status, severity from public.findings
    where org_id = v_org.id
      and last_seen_at >= now() - interval '30 days'
  )
  select jsonb_build_object(
    'window_days',        30,
    'open_critical',      (select count(*) from recent where status='open' and severity='critical'),
    'open_high',          (select count(*) from recent where status='open' and severity='high'),
    'fixed_last_30d',     (select count(*) from recent where status='fixed'),
    'dismissed_last_30d', (select count(*) from recent where status in ('false_positive','dismissed_by_ai','wont_fix')),
    'total_last_30d',     (select count(*) from recent)
  )
  into v_stats;

  -- Step 4: recent resolved highlights — title + when. Last 5 resolutions
  -- in the past 30 days. Carries enough info to seed the "Recent
  -- improvements" feed without exposing endpoint / CVE detail.
  with recent_resolved as (
    select
      f.title,
      f.severity,
      coalesce(f.triaged_at, f.last_seen_at) as resolved_at,
      f.status
    from public.findings f
    where f.org_id = v_org.id
      and f.status in ('fixed','false_positive','wont_fix')
      and coalesce(f.triaged_at, f.last_seen_at) >= now() - interval '30 days'
    order by coalesce(f.triaged_at, f.last_seen_at) desc
    limit 5
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'title',        title,
      'severity',     severity,
      'resolved_at',  resolved_at,
      'status',       status
    )
  ), '[]'::jsonb)
  into v_recent_resolved
  from recent_resolved;

  -- Step 5: assemble + return.
  return jsonb_build_object(
    'org', jsonb_build_object(
      'name',                v_org.name,
      'slug',                v_org.slug,
      'subtitle',            v_org.trust_page_subtitle,
      'plan',                v_org.plan,
      'published_at',        v_org.trust_page_published_at,
      'monitoring_since',    v_org.created_at
    ),
    'frameworks',         v_postures,
    'stats',              v_stats,
    'recent_resolved',    v_recent_resolved,
    'generated_at',       now()
  );
end;
$$;

revoke execute on function public.get_trust_page_payload(text) from public;
grant   execute on function public.get_trust_page_payload(text) to anon, authenticated, service_role;

comment on function public.get_trust_page_payload(text) is
  'Public trust-page payload. Returns null for unknown slugs or orgs '
  'with trust_page_enabled=false. The only path anonymous traffic can '
  'read compliance evidence — direct table reads are RLS-denied.';
