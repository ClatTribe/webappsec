-- Projects — Phase C of the org-scale onboarding plan.
--
-- An organisation with 200 targets doesn't think "I have 200 targets."
-- They think "I have 15 services" — each with its repo, web app, API,
-- container image, and the cloud account it deploys to. Today we
-- flatten that mental model: every target row is a peer.
--
-- Projects introduce the missing layer: a per-org grouping that owns
-- a set of targets, has criticality + owner metadata, and rolls up
-- findings / compliance posture in one query. Operational wins:
--
--   - "How's the payments service doing?" becomes a one-query answer.
--   - Compliance posture filters by project (a single SOC 2 audit
--     often only covers some services).
--   - Findings inherit project context for cross-team routing.
--   - Risk-weighted scoring uses criticality (tier_1 finding > tier_3).
--   - The natural home for ownership and per-team scopes (Phase D).
--
-- Data model is intentionally lean for v1: tags JSONB for everything
-- we don't yet have a dedicated column for, single owner_user_id
-- (no teams table yet — that's a follow-up). project_id on targets
-- is nullable so existing rows keep working unchanged.

-- ============================================================================
-- 1. projects table
-- ============================================================================

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  -- URL-safe slug for /projects/<slug>. Per-org unique; auto-derived
  -- from `name` at create time by the API but stored explicitly so
  -- rename doesn't break links.
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description text check (length(description) <= 2048),
  -- Criticality drives risk-weighted scoring + alert thresholds.
  -- tier_1 = payments / auth / production data plane.
  -- tier_2 = customer-facing but recoverable (marketing site).
  -- tier_3 = internal tools, dev infra.
  -- tier_4 = experiments, sandboxes.
  criticality text not null default 'tier_2' check (criticality in (
    'tier_1','tier_2','tier_3','tier_4'
  )),
  -- Single owner for v1. teams.id would be the natural FK in v2 when
  -- a `teams` table exists; until then we keep ownership as a single
  -- user reference to avoid a half-baked teams concept.
  owner_user_id uuid references auth.users on delete set null,
  -- Free-shape tags. Common keys (none required): env={prod,staging,dev},
  -- compliance_scope={pci,hipaa,soc2}, business_unit, line_of_business.
  tags        jsonb not null default '{}'::jsonb,
  created_by  uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (org_id, slug)
);

create index if not exists projects_org_active
  on public.projects (org_id, created_at desc)
  where archived_at is null;

create index if not exists projects_owner
  on public.projects (owner_user_id)
  where archived_at is null;

comment on table public.projects is
  'Phase C — per-org grouping of related targets. A project carries '
  'criticality + owner + tags, and rolls up findings/compliance posture '
  'across its targets. Nullable project_id on targets keeps backward-'
  'compatibility; older rows simply have no project.';

alter table public.projects enable row level security;

drop policy if exists projects_org_read on public.projects;
create policy projects_org_read on public.projects
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists projects_org_insert on public.projects;
create policy projects_org_insert on public.projects
  for insert to authenticated
  with check (
    org_id = public.current_org_id()
    and created_by = auth.uid()
  );

drop policy if exists projects_org_update on public.projects;
create policy projects_org_update on public.projects
  for update to authenticated
  using (org_id = public.current_org_id());

drop policy if exists projects_admin_delete on public.projects;
create policy projects_admin_delete on public.projects
  for delete to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- Touch trigger keeps updated_at fresh on any column change. Cheap.
create or replace function public.touch_projects_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_projects_updated_at();

-- ============================================================================
-- 2. targets.project_id
-- ============================================================================
--
-- Nullable FK — every existing target stays unaffected. Future Phase D
-- ("CSV bulk import") will let the user specify project_id at import
-- time; Phase A's discovered_asset approval will gain an optional
-- project picker that flows through to the new target row.

alter table public.targets
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists targets_project on public.targets (project_id)
  where project_id is not null;

comment on column public.targets.project_id is
  'Phase C — optional grouping into a project. NULL on legacy rows '
  '(pre-migration-078). The /projects UI exposes drag/drop to attach '
  'targets to projects after creation.';

-- ============================================================================
-- 3. Findings + scans inherit project via target_id (no schema change)
-- ============================================================================
--
-- We deliberately do NOT add project_id columns to findings/scans
-- because the data is already reachable via JOIN through targets. A
-- denormalised column would have to be backfilled + maintained by
-- triggers; the JOIN cost is negligible for our query volumes. The
-- rollup view below makes the JOIN pattern reusable.

-- ============================================================================
-- 4. Project rollup view + RPC
-- ============================================================================

-- Per-project headline counts: open critical / high / medium / low /
-- total findings, plus target count and last-scan recency.
create or replace view public.project_summary_v as
select
  p.id              as project_id,
  p.org_id,
  p.slug,
  p.name,
  p.criticality,
  p.owner_user_id,
  p.tags,
  p.archived_at,
  -- Target stats
  (select count(*) from public.targets t
     where t.project_id = p.id and t.status = 'active')             as target_count,
  (select max(t.last_scan_at) from public.targets t
     where t.project_id = p.id)                                     as last_scan_at,
  -- Open finding rollup. Severity is engine-emitted ('critical','high',
  -- 'medium','low','info'); we count strictly by (target → finding)
  -- so dismissed/fixed rows are excluded.
  (select count(*) from public.findings f
     join public.targets t on t.id = f.target_id
    where t.project_id = p.id
      and f.status = 'open'
      and f.severity = 'critical')                                  as open_critical,
  (select count(*) from public.findings f
     join public.targets t on t.id = f.target_id
    where t.project_id = p.id
      and f.status = 'open'
      and f.severity = 'high')                                      as open_high,
  (select count(*) from public.findings f
     join public.targets t on t.id = f.target_id
    where t.project_id = p.id
      and f.status = 'open'
      and f.severity = 'medium')                                    as open_medium,
  (select count(*) from public.findings f
     join public.targets t on t.id = f.target_id
    where t.project_id = p.id
      and f.status = 'open'
      and f.severity = 'low')                                       as open_low,
  (select count(*) from public.findings f
     join public.targets t on t.id = f.target_id
    where t.project_id = p.id
      and f.status = 'open')                                        as open_total
from public.projects p;

comment on view public.project_summary_v is
  'Phase C — per-project headline rollup. Used by /projects index + '
  'detail pages. Inherits RLS from underlying tables; each member '
  'only sees their org''s projects.';

-- ============================================================================
-- 5. Bulk attach RPC (admin-only)
-- ============================================================================
-- Attach N targets to one project in a single round-trip. The bulk
-- approval flow from PR #128 (discovered assets) can optionally call
-- this after import to slot the freshly-created targets into a
-- project.

create or replace function public.attach_targets_to_project(
  p_project_id uuid,
  p_target_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id  uuid;
  v_user_id uuid;
  v_count   integer;
  v_proj_org uuid;
begin
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null then
    raise exception 'no active org';
  end if;

  select org_id into v_proj_org from public.projects where id = p_project_id;
  if v_proj_org is null then
    raise exception 'project not found';
  end if;
  if v_proj_org <> v_org_id then
    raise exception 'project does not belong to current org';
  end if;

  update public.targets
     set project_id = p_project_id
   where id = any(p_target_ids)
     and org_id = v_org_id;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (org_id, user_id, action, resource_type, resource_id, metadata)
    values (
      v_org_id, v_user_id,
      'project.targets_attached',
      'project',
      p_project_id,
      jsonb_build_object('count', v_count, 'target_ids', to_jsonb(p_target_ids))
    );
  end if;

  return v_count;
end;
$$;

revoke execute on function public.attach_targets_to_project(uuid, uuid[])
  from public, anon;
grant execute on function public.attach_targets_to_project(uuid, uuid[])
  to authenticated, service_role;

-- Sister RPC — detach (set project_id = NULL).
create or replace function public.detach_targets_from_project(
  p_target_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id  uuid;
  v_user_id uuid;
  v_count   integer;
begin
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null then
    raise exception 'no active org';
  end if;

  update public.targets
     set project_id = null
   where id = any(p_target_ids)
     and org_id = v_org_id
     and project_id is not null;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (org_id, user_id, action, resource_type, metadata)
    values (
      v_org_id, v_user_id,
      'project.targets_detached',
      'target',
      jsonb_build_object('count', v_count, 'target_ids', to_jsonb(p_target_ids))
    );
  end if;

  return v_count;
end;
$$;

revoke execute on function public.detach_targets_from_project(uuid[])
  from public, anon;
grant execute on function public.detach_targets_from_project(uuid[])
  to authenticated, service_role;
