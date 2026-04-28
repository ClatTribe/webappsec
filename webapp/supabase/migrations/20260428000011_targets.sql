-- Targets as a first-class entity.
--
-- Until now, every scan carried its own ad-hoc list of `scan_targets` and
-- there was no persistent "asset I scan repeatedly" concept. Findings were
-- attached to the scan, not the target, so users couldn't see "all the open
-- issues against my prod-api repo" without joining through scans.
--
-- This migration:
--   1. Adds `public.targets`: one row per asset, unique per (org_id, value)
--   2. Adds `scans.target_id` and `findings.target_id` (nullable for legacy)
--   3. Backfills both: dedups existing scan_targets values into targets,
--      links the existing scans + findings rows to them
--   4. Adds a trigger so any future scan_targets insert auto-creates or
--      auto-links a target — backward compatible with the current API
--   5. Updates worker_insert_finding to copy target_id from the parent scan,
--      so new findings are attached to the target without code changes
--   6. Maintains targets.last_scan_at when scans land

create table if not exists public.targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  name text not null,
  type text not null check (type in ('local_code','repository','web_application','domain','ip_address')),
  value text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  last_scan_at timestamptz,
  scan_frequency text default 'manual' check (scan_frequency in ('manual','daily','weekly','monthly')),
  status text not null default 'active' check (status in ('active','archived')),
  unique (org_id, value)
);

create index if not exists targets_org on public.targets (org_id);

alter table public.targets enable row level security;

drop policy if exists targets_org_read   on public.targets;
drop policy if exists targets_org_insert on public.targets;
drop policy if exists targets_org_update on public.targets;
drop policy if exists targets_admin_delete on public.targets;

create policy targets_org_read on public.targets
  for select to authenticated
  using (org_id = public.current_org_id());

create policy targets_org_insert on public.targets
  for insert to authenticated
  with check (org_id = public.current_org_id() and created_by = auth.uid());

create policy targets_org_update on public.targets
  for update to authenticated
  using (org_id = public.current_org_id());

create policy targets_admin_delete on public.targets
  for delete to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- Add target_id to scans + findings, nullable for legacy rows.
alter table public.scans
  add column if not exists target_id uuid references public.targets(id) on delete set null;
create index if not exists scans_target on public.scans (target_id);

alter table public.findings
  add column if not exists target_id uuid references public.targets(id) on delete set null;
create index if not exists findings_target on public.findings (target_id);

-- ============== BACKFILL ==============
do $$
declare
  r record;
  v_target_id uuid;
begin
  for r in
    select distinct on (s.id)
           s.id as scan_id, s.org_id, s.user_id, st.type, st.value
    from public.scans s
    join public.scan_targets st on st.scan_id = s.id
    where s.target_id is null
    order by s.id, st.id  -- pick the first scan_target as the canonical target
  loop
    select id into v_target_id from public.targets
      where org_id = r.org_id and value = r.value
      limit 1;
    if v_target_id is null then
      insert into public.targets (org_id, name, type, value, created_by)
      values (r.org_id, r.value, r.type, r.value, r.user_id)
      returning id into v_target_id;
    end if;
    update public.scans    set target_id = v_target_id where id = r.scan_id and target_id is null;
    update public.findings set target_id = v_target_id where scan_id = r.scan_id and target_id is null;
  end loop;
end $$;

-- Set last_scan_at from existing data.
update public.targets t
set last_scan_at = sub.max_at
from (
  select target_id, max(coalesce(finished_at, started_at, created_at)) as max_at
  from public.scans where target_id is not null
  group by target_id
) sub
where t.id = sub.target_id and t.last_scan_at is null;

-- ============== TRIGGER: auto-link target on scan_targets insert ==============
-- If a scan was created without target_id (e.g. legacy frontend code path),
-- the first scan_targets insert ensures a target exists for that value and
-- back-fills scans.target_id.
create or replace function public.ensure_target_for_scan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_user_id uuid;
  v_target_id uuid;
  v_existing_target_id uuid;
begin
  select target_id into v_existing_target_id from public.scans where id = new.scan_id;
  if v_existing_target_id is not null then
    return new;
  end if;

  select org_id, user_id into v_org_id, v_user_id from public.scans where id = new.scan_id;

  select id into v_target_id from public.targets
    where org_id = v_org_id and value = new.value
    limit 1;

  if v_target_id is null then
    insert into public.targets (org_id, name, type, value, created_by)
    values (v_org_id, new.value, new.type, new.value, v_user_id)
    on conflict (org_id, value) do update set name = excluded.name
    returning id into v_target_id;
  end if;

  update public.scans set target_id = v_target_id where id = new.scan_id;
  return new;
end;
$$;

drop trigger if exists scan_targets_ensure_target on public.scan_targets;
create trigger scan_targets_ensure_target
  after insert on public.scan_targets
  for each row execute function public.ensure_target_for_scan();

-- ============== TRIGGER: bump targets.last_scan_at when scans transition state ==============
create or replace function public.update_target_last_scan_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_id is not null then
    update public.targets
      set last_scan_at = greatest(coalesce(last_scan_at, '-infinity'::timestamptz), now())
      where id = new.target_id;
  end if;
  return new;
end;
$$;

drop trigger if exists scans_update_target_last_scan on public.scans;
create trigger scans_update_target_last_scan
  after insert or update of status on public.scans
  for each row execute function public.update_target_last_scan_at();

-- ============== UPDATE worker_insert_finding TO PROPAGATE target_id ==============
-- Mirrors migration 010 but fills in findings.target_id from the parent scan.
create or replace function public.worker_insert_finding(
  p_scan_id uuid,
  p_vuln_id text,
  p_title text,
  p_severity text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_target_id uuid;
  v_id uuid;
  v_fp text;
  v_existing_id uuid;
  v_existing_status text;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_insert_finding requires service role';
  end if;

  select org_id, target_id into v_org_id, v_target_id
  from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  v_fp := nullif(p_payload->>'fingerprint', '');

  if v_fp is not null then
    select id, status into v_existing_id, v_existing_status
    from public.findings
    where org_id = v_org_id and fingerprint = v_fp
    limit 1;

    if v_existing_id is not null then
      update public.findings
      set times_seen        = times_seen + 1,
          last_seen_at      = now(),
          last_seen_scan_id = p_scan_id,
          target_id         = coalesce(target_id, v_target_id)
      where id = v_existing_id;

      if v_existing_status in ('open', 'triaged_real') then
        perform public.worker_insert_scan_event(
          p_scan_id, 'finding.recurred',
          jsonb_build_object(
            'finding_id', v_existing_id,
            'vuln_id',    p_vuln_id,
            'title',      p_title,
            'severity',   p_severity,
            'status',     v_existing_status
          )
        );
      end if;

      return v_existing_id;
    end if;
  end if;

  insert into public.findings (
    scan_id, org_id, target_id, vuln_id, title, severity,
    cvss, cvss_vector, cwe, cve, target, endpoint, method,
    description_md, technical_analysis_md, poc_md, impact_md, remediation_md,
    affected_files, fingerprint,
    last_seen_scan_id
  )
  values (
    p_scan_id, v_org_id, v_target_id, p_vuln_id, p_title, p_severity,
    (p_payload->>'cvss')::numeric,
    p_payload->>'cvss_vector',
    p_payload->>'cwe',
    p_payload->>'cve',
    p_payload->>'target',
    p_payload->>'endpoint',
    p_payload->>'method',
    p_payload->>'description_md',
    p_payload->>'technical_analysis_md',
    p_payload->>'poc_md',
    p_payload->>'impact_md',
    p_payload->>'remediation_md',
    p_payload->'affected_files',
    v_fp,
    p_scan_id
  )
  returning id into v_id;

  perform public.worker_insert_scan_event(
    p_scan_id, 'finding.created',
    jsonb_build_object(
      'finding_id', v_id,
      'vuln_id',    p_vuln_id,
      'title',      p_title,
      'severity',   p_severity
    )
  );

  return v_id;
end;
$$;

revoke execute on function public.worker_insert_finding(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant   execute on function public.worker_insert_finding(uuid, text, text, text, jsonb)
  to service_role;
