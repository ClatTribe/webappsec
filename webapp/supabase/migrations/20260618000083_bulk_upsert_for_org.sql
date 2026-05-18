-- Service-role sibling of bulk_upsert_targets — Phase D follow-up.
--
-- Migration 079's `bulk_upsert_targets(p_targets, p_project_slug)`
-- uses `current_org_id()` + `auth.uid()` from the JWT. That works
-- for session-authenticated calls from the browser but blocks the
-- API-token path (Bearer-key calls from CI / CMDB sync scripts):
-- there's no user JWT in that path, so `current_org_id()` returns
-- NULL and the RPC raises.
--
-- The sibling RPC `bulk_upsert_targets_for_org` takes org_id +
-- user_id as explicit parameters. The route handler resolves them
-- from the validated API key (`resolve_api_key` from migration 068)
-- before calling. Granted to service_role only — only the admin
-- client can invoke, which is the only path that has the JWT-less
-- context we're solving for.

create or replace function public.bulk_upsert_targets_for_org(
  p_org_id        uuid,
  p_user_id       uuid,
  p_targets       jsonb,
  p_project_slug  text default null
)
returns table (
  input_index    integer,
  external_id    text,
  target_id      uuid,
  action         text,
  error          text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id    uuid;
  v_target        jsonb;
  v_idx           integer := 0;
  v_existing_id   uuid;
  v_target_id     uuid;
  v_name          text;
  v_type          text;
  v_value         text;
  v_description   text;
  v_ext_id        text;
  v_metadata      jsonb;
  v_freq          text;
  v_row_proj_id   uuid;
begin
  if p_org_id is null then
    raise exception 'p_org_id is required';
  end if;
  if jsonb_typeof(p_targets) <> 'array' then
    raise exception 'p_targets must be a jsonb array';
  end if;

  -- Optional default project lookup, scoped to the provided org.
  if p_project_slug is not null and length(p_project_slug) > 0 then
    select id into v_project_id
      from public.projects
     where org_id = p_org_id
       and slug = p_project_slug
       and archived_at is null;
    if v_project_id is null then
      raise exception 'project slug "%" not found in org', p_project_slug;
    end if;
  end if;

  for v_target in select * from jsonb_array_elements(p_targets) loop
    v_idx        := v_idx + 1;
    v_name       := nullif(trim(v_target->>'name'), '');
    v_type       := nullif(trim(v_target->>'type'), '');
    v_value      := nullif(trim(v_target->>'value'), '');
    v_description := v_target->>'description';
    v_ext_id     := nullif(trim(v_target->>'external_id'), '');
    v_metadata   := coalesce(v_target->'metadata', '{}'::jsonb);
    v_freq       := coalesce(v_target->>'scan_frequency', 'weekly');
    v_row_proj_id := nullif(trim(v_target->>'project_id'), '')::uuid;
    if v_row_proj_id is null then v_row_proj_id := v_project_id; end if;

    -- Same validation as the session-auth path.
    if v_name is null or v_type is null or v_value is null then
      input_index := v_idx;
      external_id := v_ext_id;
      target_id   := null;
      action      := 'error';
      error       := 'name, type, value are required';
      return next;
      continue;
    end if;
    if v_type not in ('local_code','repository','web_application',
                      'domain','ip_address','api','container_image',
                      'cloud_account') then
      input_index := v_idx;
      external_id := v_ext_id;
      target_id   := null;
      action      := 'error';
      error       := format('unknown type "%s"', v_type);
      return next;
      continue;
    end if;
    if v_freq not in ('manual','daily','weekly','monthly') then
      input_index := v_idx;
      external_id := v_ext_id;
      target_id   := null;
      action      := 'error';
      error       := format('unknown scan_frequency "%s"', v_freq);
      return next;
      continue;
    end if;

    -- Idempotency match.
    v_existing_id := null;
    if v_ext_id is not null then
      select id into v_existing_id
        from public.targets
       where org_id = p_org_id and external_id = v_ext_id;
    end if;
    if v_existing_id is null then
      select id into v_existing_id
        from public.targets
       where org_id = p_org_id and value = v_value;
    end if;

    if v_existing_id is not null then
      update public.targets
         set name           = v_name,
             description    = coalesce(v_description, description),
             metadata       = metadata || v_metadata,
             scan_frequency = v_freq,
             external_id    = coalesce(v_ext_id, external_id),
             project_id     = coalesce(v_row_proj_id, project_id)
       where id = v_existing_id;

      input_index := v_idx;
      external_id := v_ext_id;
      target_id   := v_existing_id;
      action      := 'updated';
      error       := null;
      return next;
    else
      begin
        insert into public.targets (
          org_id, name, type, value, description, metadata,
          scan_frequency, created_by, external_id, project_id
        ) values (
          p_org_id, v_name, v_type, v_value, v_description, v_metadata,
          v_freq, p_user_id, v_ext_id, v_row_proj_id
        )
        returning id into v_target_id;

        input_index := v_idx;
        external_id := v_ext_id;
        target_id   := v_target_id;
        action      := 'created';
        error       := null;
        return next;
      exception
        when unique_violation then
          input_index := v_idx;
          external_id := v_ext_id;
          target_id   := null;
          action      := 'error';
          error       := 'value collides with another target in this org';
          return next;
        when others then
          input_index := v_idx;
          external_id := v_ext_id;
          target_id   := null;
          action      := 'error';
          error       := sqlerrm;
          return next;
      end;
    end if;
  end loop;

  insert into public.audit_log (
    org_id, user_id, action, resource_type, metadata
  ) values (
    p_org_id, p_user_id,
    'target.bulk_imported_via_api',
    'target',
    jsonb_build_object(
      'count', v_idx,
      'project_slug', p_project_slug,
      'source', 'api_token'
    )
  );
end;
$$;

revoke execute on function public.bulk_upsert_targets_for_org(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.bulk_upsert_targets_for_org(uuid, uuid, jsonb, text)
  to service_role;

comment on function public.bulk_upsert_targets_for_org(uuid, uuid, jsonb, text) is
  'Phase D follow-up — service-role-only bulk upsert that takes '
  'org_id + user_id as explicit params. The /api/v1/targets/bulk '
  'route uses this on the API-token path after validating the key '
  'with resolve_api_key.';
