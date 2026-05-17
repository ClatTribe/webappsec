-- Bulk target import — Phase D of org-scale onboarding.
--
-- An enterprise customer already maintains an asset inventory in their
-- CMDB / Terraform state / internal spreadsheet. They don't want to
-- type 200 targets through a form, and they don't want to wait for
-- our connect-once-discover-N (Phase A) to grow a discoverer for
-- every cloud they use. The bulk-import path is the escape hatch:
-- POST a JSON array (or upload a CSV) → N targets land in one round-trip.
--
-- Two ergonomic improvements over a naive insert-loop:
--
--   1. Idempotency keys. The customer's CMDB has stable ids per
--      asset; we accept those as `external_id` on the target. Re-
--      running the import is a no-op (existing rows get touched but
--      not duplicated). Their nightly sync script doesn't need state.
--
--   2. Per-row outcome rows. The RPC returns (external_id, target_id,
--      action, error) per input row so the caller can see which
--      created vs updated vs failed without parsing exceptions.
--
-- Plus: optional project_slug arg attaches every imported target to
-- one project in the same transaction — common case when a team
-- imports "every payments service repo" in one shot.

-- ============================================================================
-- 1. targets.external_id
-- ============================================================================
--
-- Nullable; unique per org when set so two orgs can both carry their
-- own `cmdb-payments-api` without colliding, but inside one org the
-- external_id is the stable upsert key.

alter table public.targets
  add column if not exists external_id text;

create unique index if not exists targets_org_external_id
  on public.targets (org_id, external_id)
  where external_id is not null;

comment on column public.targets.external_id is
  'Phase D — customer-supplied stable identifier for idempotent bulk '
  'import (CMDB id, Terraform resource address, etc). NULL on rows '
  'created via the regular forms. Unique per org when set so a '
  're-run of the bulk import is a no-op.';

-- ============================================================================
-- 2. bulk_upsert_targets RPC
-- ============================================================================
--
-- Input: a JSONB array of target rows. Required keys per row: name,
-- type, value. Optional: external_id, metadata, scan_frequency,
-- description, project_id (UUID — overrides p_project_slug for that
-- row). The RPC validates each row independently and returns an
-- outcome row per input row so partial-success is observable.
--
-- Resolution order for idempotency:
--   1. (org_id, external_id) match → update (idempotent re-import).
--   2. (org_id, value) match → update (caller didn't set external_id
--      but the value already exists — same asset; we adopt the
--      external_id if newly supplied).
--   3. No match → insert.
--
-- The function is SECURITY DEFINER so the wrapper can call it via the
-- public API path without exposing every column of targets to direct
-- writes. Admin role is NOT required — any org member can bulk-import
-- (matches the regular /targets/new form which also doesn't require
-- admin).

create or replace function public.bulk_upsert_targets(
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
  v_org_id        uuid;
  v_user_id       uuid;
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
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null then
    raise exception 'no active org';
  end if;
  if jsonb_typeof(p_targets) <> 'array' then
    raise exception 'p_targets must be a jsonb array';
  end if;

  -- Resolve optional default project once.
  if p_project_slug is not null and length(p_project_slug) > 0 then
    select id into v_project_id
      from public.projects
     where org_id = v_org_id
       and slug = p_project_slug
       and archived_at is null;
    if v_project_id is null then
      raise exception 'project slug "%" not found in this org', p_project_slug;
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

    -- Per-row project override (UUID); fall back to the default.
    v_row_proj_id := nullif(trim(v_target->>'project_id'), '')::uuid;
    if v_row_proj_id is null then v_row_proj_id := v_project_id; end if;

    -- Validate required shape.
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
       where org_id = v_org_id and external_id = v_ext_id;
    end if;
    if v_existing_id is null then
      select id into v_existing_id
        from public.targets
       where org_id = v_org_id and value = v_value;
    end if;

    if v_existing_id is not null then
      -- Update path. We touch metadata (merge) and overwrite the
      -- light-weight fields; we don't churn created_by or created_at.
      -- project_id only changes when an override was supplied; we
      -- don't unset an existing attachment by leaving p_project_slug
      -- empty.
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
          v_org_id, v_name, v_type, v_value, v_description, v_metadata,
          v_freq, v_user_id, v_ext_id, v_row_proj_id
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

  -- Single audit_log row per batch — easier to read than one per
  -- target when an org imports 200 at a time.
  insert into public.audit_log (
    org_id, user_id, action, resource_type, metadata
  ) values (
    v_org_id, v_user_id,
    'target.bulk_imported',
    'target',
    jsonb_build_object(
      'count', v_idx,
      'project_slug', p_project_slug
    )
  );
end;
$$;

revoke execute on function public.bulk_upsert_targets(jsonb, text) from public, anon;
grant execute on function public.bulk_upsert_targets(jsonb, text)
  to authenticated, service_role;

comment on function public.bulk_upsert_targets(jsonb, text) is
  'Phase D — bulk-import N targets in one round-trip. Returns per-row '
  'outcome (created / updated / error) so the caller can show a '
  'preview-and-confirm UX without re-running the validation client-'
  'side. Idempotent on (org_id, external_id) when set, else on '
  '(org_id, value).';
