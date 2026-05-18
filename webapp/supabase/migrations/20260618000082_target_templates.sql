-- Target templates — Phase B of org-scale onboarding.
--
-- After Phase A (asset discovery), Phase D (bulk import), and Phase E
-- (webhook auto-registration) onboard targets quickly, the next
-- friction point is per-target configuration: the customer has to
-- repeat scan_frequency / scan_mode / exclude_paths / rate_limit /
-- auth defaults for every asset they add. With 50 production web
-- apps that share the same shape, that's 50× the same form.
--
-- Templates fix this. The customer creates one template ("prod web
-- apps") that holds the shared config; every attached target inherits
-- it. Edits to the template propagate to all attached targets.
--
-- Data model:
--
--   target_templates(id, org_id, name, slug, asset_type, config jsonb, ...)
--   targets.template_id (nullable) — soft attach; null means no
--                                    template
--
-- The template is the SOURCE OF TRUTH for the attached targets'
-- scannable config. When the wrapper resolves a target's effective
-- config (for scan dispatch, UI display, etc.), it merges:
--
--    template.config (when template_id is set)
-- ∪  target.config   (per-target overrides win)
--
-- Implementation: a SECURITY DEFINER view + helper RPC. We don't
-- denormalise the merged config into targets.config because (a)
-- template edits would need a backfill trigger, (b) we'd lose the
-- "which override came from where" answer auditors want.

-- ============================================================================
-- 1. target_templates
-- ============================================================================

create table if not exists public.target_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  -- URL-safe slug for /settings/target-templates/<slug>. Per-org
  -- unique; auto-derived from name on POST.
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description text check (length(description) <= 2048),
  -- A template applies to one target type — "prod web apps" doesn't
  -- meaningfully apply to repos. Null means any-type (rare; e.g. a
  -- shared "skip these paths" config).
  asset_type  text check (asset_type in (
    'local_code','repository','web_application','domain',
    'ip_address','api','container_image','cloud_account'
  )),
  -- The shared config. Free-shape JSONB; convention keys are the
  -- same ones target.config uses today (scan_mode, scan_frequency,
  -- rate_limit_qps, exclude_paths, seed_urls, auth_method, ...).
  config      jsonb not null default '{}'::jsonb,
  -- Optional tags duplicated onto attached targets' metadata for
  -- filtering. Common: env=prod, criticality=high, compliance_scope=pci.
  tags        jsonb not null default '{}'::jsonb,
  created_by  uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  unique (org_id, slug)
);

create index if not exists target_templates_org
  on public.target_templates (org_id, asset_type)
  where archived_at is null;

comment on table public.target_templates is
  'Phase B — per-org config templates that targets can inherit. Edits '
  'to the template propagate on next scan dispatch (no backfill — the '
  'effective_target_config_v view resolves the merge at query time).';

alter table public.target_templates enable row level security;

drop policy if exists target_templates_org_read on public.target_templates;
create policy target_templates_org_read on public.target_templates
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists target_templates_admin_write on public.target_templates;
create policy target_templates_admin_write on public.target_templates
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

create or replace function public.touch_target_templates_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists target_templates_touch_updated_at on public.target_templates;
create trigger target_templates_touch_updated_at
  before update on public.target_templates
  for each row execute function public.touch_target_templates_updated_at();

-- ============================================================================
-- 2. targets.template_id
-- ============================================================================
--
-- Nullable FK — every existing target stays unaffected. set null on
-- template delete so archiving a template doesn't cascade-delete the
-- attached targets.

alter table public.targets
  add column if not exists template_id uuid references public.target_templates(id) on delete set null;

create index if not exists targets_template on public.targets (template_id)
  where template_id is not null;

comment on column public.targets.template_id is
  'Phase B — optional inheritance from a target_template. NULL means '
  '"use target.config directly" (legacy behaviour). When set, the '
  'effective config is template.config + target.config (target wins).';

-- ============================================================================
-- 3. effective_target_config_v view
-- ============================================================================
--
-- The merged config every consumer should read instead of going at
-- targets.config directly. Template config provides defaults; target
-- overrides win key-by-key via JSONB ||.

create or replace view public.effective_target_config_v as
select
  t.id                    as target_id,
  t.org_id,
  t.name,
  t.type,
  t.value,
  t.template_id,
  tt.slug                 as template_slug,
  tt.name                 as template_name,
  -- Merge: template defaults, then target overrides. JSONB || does a
  -- shallow merge — same shape we'd want for the auth_method /
  -- exclude_paths keys, which are leaf values, not nested objects.
  coalesce(tt.config, '{}'::jsonb) || coalesce(t.config, '{}'::jsonb)  as effective_config,
  -- Tags merged similarly so filters work uniformly.
  coalesce(tt.tags, '{}'::jsonb) || coalesce(t.metadata->'tags', '{}'::jsonb)  as effective_tags
from public.targets t
left join public.target_templates tt
       on tt.id = t.template_id
      and tt.archived_at is null;

comment on view public.effective_target_config_v is
  'Phase B — merged template + per-target config. The wrapper scan '
  'dispatcher + UI both read from here so a template edit is visible '
  'on next read without backfill.';

-- ============================================================================
-- 4. bulk_attach_template_to_targets RPC
-- ============================================================================

create or replace function public.attach_template_to_targets(
  p_template_id uuid,
  p_target_ids  uuid[]
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
  v_t_org   uuid;
  v_t_type  text;
begin
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null or not public.has_org_role(v_org_id, 'admin') then
    raise exception 'admin role required';
  end if;

  select org_id, asset_type into v_t_org, v_t_type
    from public.target_templates
   where id = p_template_id
     and archived_at is null;
  if v_t_org is null then
    raise exception 'template not found';
  end if;
  if v_t_org <> v_org_id then
    raise exception 'template does not belong to current org';
  end if;

  update public.targets
     set template_id = p_template_id
   where id = any(p_target_ids)
     and org_id = v_org_id
     -- Type-compatibility check — null template asset_type means
     -- "any type" so we don't filter.
     and (v_t_type is null or type = v_t_type);
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (org_id, user_id, action, resource_type, resource_id, metadata)
    values (
      v_org_id, v_user_id,
      'target_template.attached',
      'target_template',
      p_template_id,
      jsonb_build_object('count', v_count, 'target_ids', to_jsonb(p_target_ids))
    );
  end if;

  return v_count;
end;
$$;

revoke execute on function public.attach_template_to_targets(uuid, uuid[])
  from public, anon;
grant execute on function public.attach_template_to_targets(uuid, uuid[])
  to authenticated, service_role;

create or replace function public.detach_template_from_targets(
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
  if v_org_id is null or not public.has_org_role(v_org_id, 'admin') then
    raise exception 'admin role required';
  end if;

  update public.targets
     set template_id = null
   where id = any(p_target_ids)
     and org_id = v_org_id
     and template_id is not null;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (org_id, user_id, action, resource_type, metadata)
    values (
      v_org_id, v_user_id,
      'target_template.detached',
      'target',
      jsonb_build_object('count', v_count, 'target_ids', to_jsonb(p_target_ids))
    );
  end if;

  return v_count;
end;
$$;

revoke execute on function public.detach_template_from_targets(uuid[])
  from public, anon;
grant execute on function public.detach_template_from_targets(uuid[])
  to authenticated, service_role;
