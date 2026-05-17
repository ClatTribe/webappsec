-- Asset discovery — Phase A.
--
-- An organisation with 200 repos and a multi-account AWS estate isn't
-- going to type 200 target forms. The connect-once-discover-N pattern
-- says: customer connects ONE integration, we enumerate everything
-- scannable inside it and propose them as `pending` assets. Customer
-- bulk-approves the subset they want monitored, and we materialise
-- those as real `targets` rows in a single transaction.
--
-- This migration ships the storage + the bulk-approve RPC. The
-- listing logic itself (GitHub → repos, AWS → ALB/Lambda/API GW, GCP
-- → Cloud Run / App Engine) lives in
-- `lib/asset-discoverers/<provider>.ts` and mirrors the
-- evidence-collector framework (migration 073) exactly.
--
-- Data model:
--
--   discovered_assets — one row per (integration × upstream resource),
--   deduped by `canonical_id` so re-running discovery is a no-op for
--   already-known assets. Status flow:
--
--      pending → approved / rejected
--      approved → imported (when the target row lands)
--      pending → superseded (when re-discovery flags it as no longer
--                            present upstream — out of scope for v1
--                            but the enum allows it)
--
-- We deliberately do NOT merge this into the `targets` table with a
-- 'pending' status because:
--   - The cron writes here unattended; targets is user-edited.
--   - The shape is different (discovered assets carry upstream
--     metadata + a suggested_config blob).
--   - Targets RLS allows authenticated org members to write; the
--     discovery cron runs as service role.

create table if not exists public.discovered_assets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  -- The integration that discovered this asset. Required — discovery
  -- is always sourced from a connected integration. (Webhook-driven
  -- discovery in Phase E will still attribute back to the originating
  -- integration row.)
  integration_id  uuid not null references public.integrations on delete cascade,
  -- Mirror the targets.type enum so import is a straight copy.
  asset_type      text not null check (asset_type in (
    'local_code','repository','web_application','domain',
    'ip_address','api','container_image','cloud_account'
  )),
  -- Stable dedup key. Discoverer-defined; convention is
  -- '<provider>:<id>' (e.g. 'github:acme/payments-api',
  -- 'aws:123456789012/elbv2/payments-alb'). Unique per integration so
  -- two AWS accounts can each surface their own 'aws:.../foo'
  -- without collision.
  canonical_id    text not null,
  display_name    text not null,
  -- Raw discovery metadata (URLs, tags, last-deploy timestamps, etc).
  -- Surfaced in the UI; never edited by the wrapper after insert.
  attributes      jsonb not null default '{}'::jsonb,
  -- The target config the discoverer recommends — auth hints,
  -- scan_mode default, exclude paths. Becomes the seed config when
  -- the customer approves the asset. They can override before import.
  suggested_config jsonb not null default '{}'::jsonb,
  confidence      text not null default 'medium' check (confidence in ('high','medium','low')),
  status          text not null default 'pending' check (status in (
    'pending','approved','rejected','imported','superseded'
  )),
  -- When status='imported', points at the target row that was
  -- created. Lets the UI show "already imported — view target".
  target_id       uuid references public.targets on delete set null,
  discovered_at   timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references auth.users on delete set null,
  -- Re-discovery uses canonical_id as the upsert key; we keep the
  -- most recent timestamp so the UI can show "discovered N days ago".
  last_seen_at    timestamptz not null default now(),
  unique (org_id, integration_id, canonical_id)
);

create index if not exists discovered_assets_org_status
  on public.discovered_assets (org_id, status, discovered_at desc);

create index if not exists discovered_assets_integration
  on public.discovered_assets (integration_id, status);

comment on table public.discovered_assets is
  'Phase A asset discovery — proposed targets enumerated from connected '
  'integrations. Status flow: pending → approved → imported (target_id '
  'set) or pending → rejected. Re-runs upsert on (org, integration, '
  'canonical_id) so an idempotent cron is safe.';

alter table public.discovered_assets enable row level security;

drop policy if exists discovered_assets_org_read on public.discovered_assets;
create policy discovered_assets_org_read on public.discovered_assets
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists discovered_assets_admin_update on public.discovered_assets;
create policy discovered_assets_admin_update on public.discovered_assets
  for update to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- Service role does inserts via the cron — no insert policy for
-- authenticated; the RLS-bypass is intentional.

-- ============================================================================
-- BULK APPROVE RPC
-- ============================================================================
--
-- Takes a list of discovered_asset ids and an optional override
-- config. For each pending asset:
--   1. Validate caller is admin in the asset's org.
--   2. Create a target row with type/name/value lifted from the
--      discovered_asset, config = suggested_config ∪ override.
--   3. Flip discovered_asset to status='imported' with target_id +
--      reviewed_at + reviewed_by stamped.
--   4. audit_log entry per import.
-- Returns rows of (asset_id, target_id, status, error).

create or replace function public.bulk_approve_discovered_assets(
  p_asset_ids       uuid[],
  p_config_override jsonb default '{}'::jsonb
)
returns table (
  asset_id   uuid,
  target_id  uuid,
  status     text,
  error      text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id     uuid;
  v_user_id    uuid;
  v_asset      record;
  v_target_id  uuid;
  v_value      text;
  v_config     jsonb;
begin
  v_org_id  := public.current_org_id();
  v_user_id := auth.uid();
  if v_org_id is null then
    raise exception 'no active org';
  end if;
  if not public.has_org_role(v_org_id, 'admin') then
    raise exception 'admin role required';
  end if;

  for v_asset in
    select id, org_id, asset_type, canonical_id, display_name,
           attributes, suggested_config, status
    from public.discovered_assets
    where id = any(p_asset_ids)
      and org_id = v_org_id
  loop
    -- Skip non-pending — re-approve shouldn't double-create.
    if v_asset.status <> 'pending' then
      asset_id := v_asset.id;
      target_id := null;
      status := v_asset.status;
      error := 'asset not in pending state';
      return next;
      continue;
    end if;

    -- The `value` column on targets is the per-type canonical
    -- identifier (repo URL, hostname, image:tag, provider/account).
    -- Discoverers store it in attributes.value; fall back to
    -- canonical_id when missing so we always create *something*.
    v_value := coalesce(v_asset.attributes->>'value', v_asset.canonical_id);

    v_config := coalesce(v_asset.suggested_config, '{}'::jsonb)
                || coalesce(p_config_override, '{}'::jsonb);

    begin
      insert into public.targets (
        org_id, name, type, value, description, metadata,
        created_by, scan_frequency
      )
      values (
        v_org_id,
        v_asset.display_name,
        v_asset.asset_type,
        v_value,
        coalesce(v_asset.attributes->>'description', null),
        v_config,
        v_user_id,
        coalesce(v_config->>'scan_frequency', 'weekly')
      )
      returning id into v_target_id;
    exception when unique_violation then
      -- Target with same (org, value) already exists — most common
      -- case is a re-import. Stamp the existing target_id on the
      -- discovered_asset so the UI shows "already imported".
      select id into v_target_id
      from public.targets
      where org_id = v_org_id and value = v_value
      limit 1;
    end;

    update public.discovered_assets
       set status      = 'imported',
           target_id   = v_target_id,
           reviewed_at = now(),
           reviewed_by = v_user_id
     where id = v_asset.id;

    insert into public.audit_log (
      org_id, user_id, action, resource_type, resource_id, metadata
    ) values (
      v_org_id, v_user_id,
      'discovered_asset.imported',
      'discovered_asset',
      v_asset.id,
      jsonb_build_object(
        'target_id', v_target_id,
        'asset_type', v_asset.asset_type,
        'canonical_id', v_asset.canonical_id
      )
    );

    asset_id := v_asset.id;
    target_id := v_target_id;
    status := 'imported';
    error := null;
    return next;
  end loop;
end;
$$;

revoke execute on function public.bulk_approve_discovered_assets(uuid[], jsonb)
  from public, anon;
grant execute on function public.bulk_approve_discovered_assets(uuid[], jsonb)
  to authenticated, service_role;

comment on function public.bulk_approve_discovered_assets(uuid[], jsonb) is
  'Phase A — converts pending discovered_assets into real targets in '
  'one round-trip. Idempotent on already-imported assets (returns the '
  'existing target_id without creating duplicates). Admin-only.';

-- ============================================================================
-- BULK REJECT RPC
-- ============================================================================
-- Sister to bulk_approve — flip to rejected with reviewer stamp +
-- audit log. Used when the customer wants to mark "we don't want to
-- ever scan this" so re-discovery doesn't re-surface the same row.

create or replace function public.bulk_reject_discovered_assets(
  p_asset_ids uuid[],
  p_reason    text default null
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

  update public.discovered_assets
     set status      = 'rejected',
         reviewed_at = now(),
         reviewed_by = v_user_id,
         attributes  = case
           when p_reason is not null
             then attributes || jsonb_build_object('reject_reason', p_reason)
           else attributes
         end
   where id = any(p_asset_ids)
     and org_id = v_org_id
     and status = 'pending';
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (org_id, user_id, action, resource_type, metadata)
    values (
      v_org_id, v_user_id,
      'discovered_asset.bulk_rejected',
      'discovered_asset',
      jsonb_build_object('count', v_count, 'reason', p_reason)
    );
  end if;

  return v_count;
end;
$$;

revoke execute on function public.bulk_reject_discovered_assets(uuid[], text)
  from public, anon;
grant execute on function public.bulk_reject_discovered_assets(uuid[], text)
  to authenticated, service_role;

-- ============================================================================
-- DUE-DISCOVERY VIEW
-- ============================================================================
-- The cron picks up integrations that haven't had a discovery run in
-- the last 24h. We store `last_discovery_at` on integrations rather
-- than a separate runs table — the discovery cron itself is the
-- audit trail (audit_log entries when assets land).

alter table public.integrations
  add column if not exists last_discovery_at timestamptz;

comment on column public.integrations.last_discovery_at is
  'Phase A — stamped by the asset-discovery cron after a successful '
  'run. NULL means "never discovered" (the first scheduled run will '
  'pick it up).';
