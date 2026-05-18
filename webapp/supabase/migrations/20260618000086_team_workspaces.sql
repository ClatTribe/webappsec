-- Per-team workspaces — foundation only.
--
-- This is the largest of the wrapper-side gaps from the architecture
-- plan. A full RBAC roll-out would touch every read path in the
-- codebase; that's a separate, scary change. This migration ships
-- the DATA MODEL + management surface so a customer can define teams
-- + memberships + which targets each team owns, without yet flipping
-- the RLS enforcement that scopes reads. Enforcement lands in a
-- follow-up per-route so the blast radius of each enable-step is
-- small.
--
-- Data model:
--
--   teams(id, org_id, name, slug, ...)
--   team_members(team_id, user_id, role)         -- many-to-many
--   team_targets(team_id, target_id)             -- which targets
--                                                   each team owns
--
-- Helper functions registered + ready to use:
--
--   user_team_ids(uuid) → uuid[]
--   user_can_view_target(uuid, uuid) → boolean
--   user_can_view_project(uuid, uuid) → boolean
--
-- Scoping policy (when enforcement is later turned on):
--   - A target with NO `team_targets` rows is org-wide visible
--     (back-compat with every existing target).
--   - A target with one or more `team_targets` rows is visible only
--     to members of those teams (and org admins, who bypass scoping).
--
-- The `team_targets` zero-row default means the new tables can land
-- without changing any existing visibility behaviour.

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description text check (length(description) <= 2048),
  created_by  uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (org_id, slug)
);

create index if not exists teams_org_active
  on public.teams (org_id, created_at desc)
  where archived_at is null;

comment on table public.teams is
  'Per-org sub-groupings of users. Currently informational (used in '
  'the UI to scope targets visually); RLS enforcement of team-scoped '
  'reads is a follow-up that lands per-route deliberately.';

alter table public.teams enable row level security;

drop policy if exists teams_org_read on public.teams;
create policy teams_org_read on public.teams
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists teams_admin_write on public.teams;
create policy teams_admin_write on public.teams
  for all to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  )
  with check (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
    and created_by = auth.uid()
  );

-- ============================================================================
-- team_members
-- ============================================================================

create table if not exists public.team_members (
  team_id    uuid not null references public.teams on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null default 'member' check (role in ('member','lead')),
  added_by   uuid references auth.users on delete set null,
  added_at   timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_user on public.team_members (user_id);

alter table public.team_members enable row level security;

drop policy if exists team_members_org_read on public.team_members;
create policy team_members_org_read on public.team_members
  for select to authenticated
  using (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
    )
  );

drop policy if exists team_members_admin_write on public.team_members;
create policy team_members_admin_write on public.team_members
  for all to authenticated
  using (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
         and public.has_org_role(t.org_id, 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
         and public.has_org_role(t.org_id, 'admin')
    )
  );

-- ============================================================================
-- team_targets — many-to-many scoping
-- ============================================================================

create table if not exists public.team_targets (
  team_id    uuid not null references public.teams on delete cascade,
  target_id  uuid not null references public.targets on delete cascade,
  added_by   uuid references auth.users on delete set null,
  added_at   timestamptz not null default now(),
  primary key (team_id, target_id)
);

create index if not exists team_targets_target on public.team_targets (target_id);

alter table public.team_targets enable row level security;

drop policy if exists team_targets_org_read on public.team_targets;
create policy team_targets_org_read on public.team_targets
  for select to authenticated
  using (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
    )
  );

drop policy if exists team_targets_admin_write on public.team_targets;
create policy team_targets_admin_write on public.team_targets
  for all to authenticated
  using (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
         and public.has_org_role(t.org_id, 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.teams t
       where t.id = team_id
         and t.org_id = public.current_org_id()
         and public.has_org_role(t.org_id, 'admin')
    )
  );

-- Touch trigger.
create or replace function public.touch_teams_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists teams_touch_updated_at on public.teams;
create trigger teams_touch_updated_at
  before update on public.teams
  for each row execute function public.touch_teams_updated_at();

-- ============================================================================
-- Helper functions for future RLS enforcement
-- ============================================================================

-- user_team_ids(p_user_id) — every team this user belongs to.
create or replace function public.user_team_ids(p_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(team_id), array[]::uuid[])
    from public.team_members
   where user_id = p_user_id;
$$;

revoke execute on function public.user_team_ids(uuid) from public, anon;
grant execute on function public.user_team_ids(uuid)
  to authenticated, service_role;

-- user_can_view_target(p_user_id, p_target_id) — true when the
-- target is org-wide (no team_targets rows) OR the user is a member
-- of at least one team that owns it. Org admins bypass.
create or replace function public.user_can_view_target(
  p_user_id   uuid,
  p_target_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id    uuid;
  v_scoped    boolean;
begin
  select org_id into v_org_id from public.targets where id = p_target_id;
  if v_org_id is null then return false; end if;

  -- Admin bypass — admins can see everything in their org.
  if public.has_org_role(v_org_id, 'admin') then return true; end if;

  select exists(
    select 1 from public.team_targets where target_id = p_target_id
  ) into v_scoped;
  if not v_scoped then return true; end if; -- no scope set = org-wide

  return exists(
    select 1
      from public.team_targets tt
      join public.team_members tm on tm.team_id = tt.team_id
     where tt.target_id = p_target_id
       and tm.user_id = p_user_id
  );
end;
$$;

revoke execute on function public.user_can_view_target(uuid, uuid)
  from public, anon;
grant execute on function public.user_can_view_target(uuid, uuid)
  to authenticated, service_role;

comment on function public.user_can_view_target(uuid, uuid) is
  'Team-scope check for a target. Returns true when (a) the user is '
  'org admin, OR (b) the target has no team_targets rows, OR (c) the '
  'user is a member of a team that owns it. NOT YET WIRED INTO RLS '
  '— the function is registered so a future migration can flip the '
  'targets read policy to use it without a separate schema change.';

-- user_can_view_project(p_user_id, p_project_id) — same semantics
-- but for projects (a project is visible if ANY of its targets is
-- visible to the user).
create or replace function public.user_can_view_project(
  p_user_id    uuid,
  p_project_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select org_id into v_org_id from public.projects where id = p_project_id;
  if v_org_id is null then return false; end if;
  if public.has_org_role(v_org_id, 'admin') then return true; end if;

  return exists(
    select 1
      from public.targets t
     where t.project_id = p_project_id
       and public.user_can_view_target(p_user_id, t.id)
  );
end;
$$;

revoke execute on function public.user_can_view_project(uuid, uuid)
  from public, anon;
grant execute on function public.user_can_view_project(uuid, uuid)
  to authenticated, service_role;
