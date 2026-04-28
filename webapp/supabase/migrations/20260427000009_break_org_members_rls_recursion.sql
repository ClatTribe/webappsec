-- Break the RLS-policy recursion on public.org_members.
--
-- The original org_members policies (in 20260427000001_rls_policies.sql) say
-- "to write to org_members, you must be admin/owner of the org" by querying
-- org_members itself inside a USING/WITH CHECK clause. RLS then re-applies
-- the org_members policies to that subquery, which queries org_members
-- again, and Postgres bails with:
--   ERROR: infinite recursion detected in policy for relation "org_members"
--
-- Fix: extract the membership lookup into a SECURITY DEFINER helper that
-- runs as the function owner (postgres) and therefore bypasses RLS for its
-- internal SELECT. The helper has a tiny surface area (one read for one user
-- in one org) so the privilege escalation risk is minimal.

create or replace function public.has_org_role(p_org_id uuid, p_min_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.org_members
    where user_id = auth.uid()
      and org_id  = p_org_id
      and role = any (
        case p_min_role
          when 'owner'  then array['owner']::text[]
          when 'admin'  then array['owner','admin']::text[]
          when 'member' then array['owner','admin','member']::text[]
          else array['owner','admin','member','viewer']::text[]
        end
      )
  );
$$;

revoke execute on function public.has_org_role(uuid, text) from public, anon;
grant   execute on function public.has_org_role(uuid, text) to authenticated, service_role;

-- Replace every org_members policy that queried org_members with helper-based
-- ones that don't. The READ policy was the most common trigger for the
-- recursion: any other table's policy that did `EXISTS (SELECT FROM org_members
-- ...)` re-applied the org_members READ policy, which then queried org_members
-- again.
drop policy if exists org_members_read         on public.org_members;
drop policy if exists org_members_admin_write  on public.org_members;
drop policy if exists org_members_admin_delete on public.org_members;

create policy org_members_read on public.org_members
  for select to authenticated
  using ( public.has_org_role(org_id, 'viewer') );

create policy org_members_admin_write on public.org_members
  for insert to authenticated
  with check ( public.has_org_role(org_id, 'admin') );

create policy org_members_admin_delete on public.org_members
  for delete to authenticated
  using ( public.has_org_role(org_id, 'admin') );
