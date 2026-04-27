-- Local-dev seed data. Runs after `supabase db reset`.
-- Creates one demo user + org so you can log in immediately.
--
-- DO NOT run this in production.

-- Demo user: demo@strix.local / demo-password-1234
-- (Supabase Auth handles password hashing; we insert through the admin API in CI usually,
-- but for purely-local dev you can run `supabase auth signup ...` after `supabase start`,
-- then run `psql -h localhost -p 54322 -U postgres -d postgres -f seed.sql`.)

do $$
declare
  v_user_id uuid;
  v_org_id uuid;
begin
  select id into v_user_id from auth.users where email = 'demo@strix.local' limit 1;
  if v_user_id is null then
    raise notice 'Create demo@strix.local via the dashboard or supabase CLI first, then re-run seed.';
    return;
  end if;

  insert into public.organizations (name, slug, plan)
  values ('Demo Org', 'demo-org', 'pro')
  returning id into v_org_id;

  insert into public.org_members (user_id, org_id, role)
  values (v_user_id, v_org_id, 'owner')
  on conflict do nothing;

  raise notice 'Seeded demo org % with owner %', v_org_id, v_user_id;
end $$;
