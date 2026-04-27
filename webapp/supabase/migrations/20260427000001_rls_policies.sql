-- Row-level security on every tenant-scoped table.
-- Pattern: org_id must match the caller's JWT 'org_id' claim (injected by the JWT hook).
--
-- The worker uses the service-role key, which BYPASSES RLS — service-role calls go through
-- security-definer RPCs in 20260427000005_worker_rpcs.sql so they still enforce org checks.

-- Helper: extract org_id from the current JWT.
create or replace function public.current_org_id()
returns uuid language sql stable as $$
  select coalesce(
    (auth.jwt() ->> 'org_id')::uuid,
    null
  );
$$;

-- =================== ENABLE RLS ===================
alter table public.profiles          enable row level security;
alter table public.organizations     enable row level security;
alter table public.org_members       enable row level security;
alter table public.integrations      enable row level security;
alter table public.scans             enable row level security;
alter table public.scan_targets      enable row level security;
alter table public.scan_integrations enable row level security;
alter table public.scan_events       enable row level security;
alter table public.findings          enable row level security;
alter table public.audit_log         enable row level security;
alter table public.api_tokens        enable row level security;

-- =================== PROFILES ===================
-- Users can see and update their own profile.
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = auth.uid());
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid());

-- =================== ORGANIZATIONS ===================
-- Members can see their orgs.
create policy organizations_member_read on public.organizations
  for select to authenticated
  using (
    id in (select org_id from public.org_members where user_id = auth.uid())
  );

-- Only owners can update org settings.
create policy organizations_owner_update on public.organizations
  for update to authenticated
  using (
    id in (
      select org_id from public.org_members
      where user_id = auth.uid() and role = 'owner'
    )
  );

-- =================== ORG_MEMBERS ===================
-- Members can see other members of their orgs.
create policy org_members_read on public.org_members
  for select to authenticated
  using (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
  );

-- Owners and admins can add/remove members.
create policy org_members_admin_write on public.org_members
  for insert to authenticated
  with check (
    org_id in (
      select om.org_id from public.org_members om
      where om.user_id = auth.uid() and om.role in ('owner','admin')
    )
  );

create policy org_members_admin_delete on public.org_members
  for delete to authenticated
  using (
    org_id in (
      select om.org_id from public.org_members om
      where om.user_id = auth.uid() and om.role in ('owner','admin')
    )
  );

-- =================== INTEGRATIONS ===================
create policy integrations_org_read on public.integrations
  for select to authenticated using (org_id = public.current_org_id());

create policy integrations_org_insert on public.integrations
  for insert to authenticated with check (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = integrations.org_id
        and role in ('owner','admin','member')
    )
  );

create policy integrations_org_update on public.integrations
  for update to authenticated using (org_id = public.current_org_id());

create policy integrations_org_delete on public.integrations
  for delete to authenticated using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = integrations.org_id
        and role in ('owner','admin')
    )
  );

-- =================== SCANS ===================
create policy scans_org_read on public.scans
  for select to authenticated using (org_id = public.current_org_id());

create policy scans_org_insert on public.scans
  for insert to authenticated with check (
    org_id = public.current_org_id() and user_id = auth.uid()
  );

-- viewers can't update/cancel; members and above can
create policy scans_member_update on public.scans
  for update to authenticated using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = scans.org_id
        and role in ('owner','admin','member')
    )
  );

-- =================== SCAN_TARGETS / SCAN_INTEGRATIONS ===================
create policy scan_targets_read on public.scan_targets
  for select to authenticated using (
    scan_id in (select id from public.scans where org_id = public.current_org_id())
  );

create policy scan_targets_insert on public.scan_targets
  for insert to authenticated with check (
    scan_id in (select id from public.scans where org_id = public.current_org_id())
  );

create policy scan_integrations_read on public.scan_integrations
  for select to authenticated using (
    scan_id in (select id from public.scans where org_id = public.current_org_id())
  );

create policy scan_integrations_insert on public.scan_integrations
  for insert to authenticated with check (
    scan_id in (select id from public.scans where org_id = public.current_org_id())
  );

-- =================== SCAN_EVENTS ===================
-- Read-only for clients; worker writes via service role (security-definer RPC).
create policy scan_events_org_read on public.scan_events
  for select to authenticated using (org_id = public.current_org_id());

-- =================== FINDINGS ===================
create policy findings_org_read on public.findings
  for select to authenticated using (org_id = public.current_org_id());

-- Triage updates allowed for members.
create policy findings_member_update on public.findings
  for update to authenticated using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = findings.org_id
        and role in ('owner','admin','member')
    )
  );

-- =================== AUDIT_LOG ===================
-- Read-only for org admins.
create policy audit_log_admin_read on public.audit_log
  for select to authenticated using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = audit_log.org_id
        and role in ('owner','admin')
    )
  );

-- =================== API_TOKENS ===================
create policy api_tokens_org_read on public.api_tokens
  for select to authenticated using (org_id = public.current_org_id());

create policy api_tokens_admin_write on public.api_tokens
  for insert to authenticated with check (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = api_tokens.org_id
        and role in ('owner','admin')
    )
  );

create policy api_tokens_admin_delete on public.api_tokens
  for delete to authenticated using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members
      where user_id = auth.uid() and org_id = api_tokens.org_id
        and role in ('owner','admin')
    )
  );

-- =================== STORAGE BUCKET POLICIES ===================

-- scan-artifacts bucket: members of the org can read; only service role writes.
create policy "members read scan artifacts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'scan-artifacts'
    and (storage.foldername(name))[1]::uuid = public.current_org_id()
  );

create policy "service role writes scan artifacts"
  on storage.objects for insert to service_role
  with check (bucket_id = 'scan-artifacts');

-- user-uploads bucket: members can upload to their org's prefix.
create policy "members upload user files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1]::uuid = public.current_org_id()
  );

create policy "members read user files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1]::uuid = public.current_org_id()
  );
