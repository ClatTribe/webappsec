-- Custom access token hook: inject org_id into the JWT.
--
-- After this migration runs, manually enable the hook in:
--   Supabase Dashboard → Authentication → Hooks → Custom Access Token →
--     select public.custom_access_token_hook
--
-- For local dev, set in `supabase/config.toml`:
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/public/custom_access_token_hook"

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  user_id uuid;
  selected_org uuid;
  user_role text;
begin
  user_id := (event->>'user_id')::uuid;

  -- If the client passed an org override (e.g. when switching orgs), use it after verifying membership.
  selected_org := nullif(event->'claims'->>'org_id', '')::uuid;

  if selected_org is not null then
    select role into user_role
    from public.org_members
    where org_members.user_id = user_id and org_members.org_id = selected_org;

    if user_role is null then
      selected_org := null;  -- not a member; fall through
    end if;
  end if;

  -- Otherwise default to the user's primary (oldest) org.
  if selected_org is null then
    select org_id, role
      into selected_org, user_role
    from public.org_members
    where org_members.user_id = user_id
    order by created_at asc
    limit 1;
  end if;

  if selected_org is not null then
    event := jsonb_set(event, '{claims,org_id}', to_jsonb(selected_org::text));
    event := jsonb_set(event, '{claims,org_role}', to_jsonb(user_role));
  end if;

  return event;
end;
$$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
