-- Subdomain auto-discovery (roadmap §9 #1).
--
-- Mental model: the user types `acme.com` once and means "scan my company".
-- We enumerate subdomains via Certificate Transparency logs (crt.sh) and
-- present them as suggested targets; the user accepts the ones worth
-- scanning, dismisses the rest. Promoted discoveries become regular targets
-- and link back to the parent so the relationship survives.
--
-- Source-of-truth is the worker (it has the network egress + the listener
-- already). This migration just adds the schema, a notify trigger, and
-- the user-facing promote / dismiss RPCs.

-- ============================================================
-- target_discoveries table
-- ============================================================

create table if not exists public.target_discoveries (
  id              uuid primary key default gen_random_uuid(),
  target_id       uuid not null references public.targets(id) on delete cascade,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  source          text not null check (source in ('crt_sh', 'subfinder', 'manual')),
  value           text not null,                              -- the discovered subdomain
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'pending'
                    check (status in ('pending', 'accepted', 'dismissed')),
  promoted_target_id uuid references public.targets(id) on delete set null,
  unique (target_id, value)
);

create index if not exists target_discoveries_target on public.target_discoveries (target_id);
create index if not exists target_discoveries_org_pending
  on public.target_discoveries (org_id) where status = 'pending';

alter table public.target_discoveries enable row level security;

drop policy if exists target_discoveries_org_read   on public.target_discoveries;
drop policy if exists target_discoveries_org_update on public.target_discoveries;

-- Read: anyone in the org sees their org's discoveries.
create policy target_discoveries_org_read on public.target_discoveries
  for select to authenticated
  using (org_id = public.current_org_id());

-- Update: org members can dismiss / re-open. Promotion happens via the
-- RPC below (which still updates this table — RLS on UPDATE allows it).
create policy target_discoveries_org_update on public.target_discoveries
  for update to authenticated
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

-- No INSERT or DELETE policy — only the worker (service role) writes.
grant select, update on public.target_discoveries to authenticated;
grant all on public.target_discoveries to service_role;


-- ============================================================
-- pg_notify on new domain targets so the worker kicks off discovery
-- ============================================================

create or replace function public.notify_target_discovery_requested()
returns trigger
language plpgsql
as $$
begin
  -- We only run discovery on domain targets today. Other types (repository,
  -- ip_address, web_application, local_code) don't have meaningful CT-log
  -- subdomain enumeration to do.
  if new.type = 'domain' then
    perform pg_notify('target_discovery_requested', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists targets_after_insert_discovery on public.targets;
create trigger targets_after_insert_discovery
  after insert on public.targets
  for each row
  execute function public.notify_target_discovery_requested();


-- ============================================================
-- promote_discovery_to_target RPC
-- ============================================================
-- User clicks "Accept" on a discovered subdomain → it becomes a real
-- target row, scoped to the same org. The discovery row stays as an audit
-- trail, status flipped to 'accepted', linked to the new target.

create or replace function public.promote_discovery_to_target(p_discovery_id uuid)
returns uuid
language plpgsql
security invoker                          -- caller's JWT; RLS on every read+write
set search_path = public
as $$
declare
  v_disc record;
  v_new_target_id uuid;
begin
  select id, target_id, org_id, value, status, promoted_target_id
    into v_disc
  from public.target_discoveries
  where id = p_discovery_id;

  if v_disc.id is null then
    raise exception 'discovery not found';
  end if;

  if v_disc.status = 'accepted' and v_disc.promoted_target_id is not null then
    -- Idempotent: already promoted, return the same target id.
    return v_disc.promoted_target_id;
  end if;

  -- Insert under the user's JWT so RLS validates org membership.
  insert into public.targets (org_id, name, type, value, created_by, description)
  values (
    v_disc.org_id,
    v_disc.value,
    'domain',
    v_disc.value,
    auth.uid(),
    'Auto-discovered subdomain'
  )
  returning id into v_new_target_id;

  update public.target_discoveries
  set status = 'accepted', promoted_target_id = v_new_target_id, last_seen_at = now()
  where id = p_discovery_id;

  return v_new_target_id;
end;
$$;

revoke execute on function public.promote_discovery_to_target(uuid) from public, anon;
grant   execute on function public.promote_discovery_to_target(uuid) to authenticated, service_role;
