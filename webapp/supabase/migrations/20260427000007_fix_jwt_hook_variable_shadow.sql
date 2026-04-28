-- Fixes for the JWT hook from migration 20260427000002:
--
-- 1. The local variable `user_id uuid` shadowed `org_members.user_id`,
--    causing "column reference 'user_id' is ambiguous" on every login.
--    Renamed to v_user_id.
--
-- 2. The function ran as the calling role (supabase_auth_admin) and queried
--    public.org_members, which auth_admin has no SELECT permission on,
--    causing "permission denied for table org_members" on every login.
--    Marked SECURITY DEFINER so the function runs as its owner (postgres),
--    which has access. SET search_path is locked to prevent search_path
--    hijacking exploits in security-definer code.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  selected_org uuid;
  user_role text;
begin
  v_user_id := (event->>'user_id')::uuid;

  -- If the client passed an org override (e.g. when switching orgs), use it after verifying membership.
  selected_org := nullif(event->'claims'->>'org_id', '')::uuid;

  if selected_org is not null then
    select role into user_role
    from public.org_members
    where org_members.user_id = v_user_id and org_members.org_id = selected_org;

    if user_role is null then
      selected_org := null;  -- not a member; fall through
    end if;
  end if;

  -- Otherwise default to the user's primary (oldest) org.
  if selected_org is null then
    select org_id, role
      into selected_org, user_role
    from public.org_members
    where org_members.user_id = v_user_id
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
