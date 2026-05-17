-- Auditor share-link — AISecurityEngineerUXRoadmap.md §5 Phase C.
--
-- The public trust page (#81) is for prospects: summary-grade
-- evidence + recent improvements. Auditors want one level deeper —
-- raw control verdicts, the signed evidence chain, downloadable
-- compliance_pack reference. But the auditor isn't going to sign up
-- for a TensorShield account.
--
-- This migration ships time-bounded, revocable, anonymous-readable
-- URLs. The founder generates one (`/audit/<token>`), shares it with
-- the auditor, the auditor sees the deep evidence for as long as the
-- link is alive. Revocable mid-flight. Access is audit-logged.
--
-- Security model:
--   - Token is gen_random_bytes(32) → base64url. ~43 char URL-safe.
--     Unguessable; we don't list these anywhere except the owner's
--     settings UI.
--   - Single SECURITY DEFINER lookup function (get_audit_share_payload)
--     is the ONLY path the public reads through. Direct table reads
--     are RLS-denied for anon.
--   - Each access bumps a counter + writes an audit_log entry so the
--     org can see who opened the link, when, and from where (IP is
--     captured by the API route, not stored at DB layer).

create table if not exists public.audit_share_links (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete cascade,
  token        text not null unique,
  label        text,                          -- "Acme Corp SOC 2 Type 2 audit, March 2026"
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  access_count int not null default 0,
  last_accessed_at timestamptz,
  created_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists audit_share_links_org   on public.audit_share_links (org_id, created_at desc);
create index if not exists audit_share_links_token on public.audit_share_links (token) where revoked_at is null;

comment on table public.audit_share_links is
  'Time-bounded anonymous-readable URLs into an org''s deeper compliance '
  'evidence. Generated from settings; revocable; audit-logged on each '
  'access. The token is the secret — never list it back to non-creators.';

alter table public.audit_share_links enable row level security;

-- Org admins/owners can see the org's share links (to manage them).
-- Anon never reads this table directly; only via the SECURITY DEFINER
-- get_audit_share_payload function.

drop policy if exists audit_share_links_admin_read on public.audit_share_links;
create policy audit_share_links_admin_read on public.audit_share_links
  for select to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

drop policy if exists audit_share_links_admin_insert on public.audit_share_links;
create policy audit_share_links_admin_insert on public.audit_share_links
  for insert to authenticated
  with check (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

drop policy if exists audit_share_links_admin_update on public.audit_share_links;
create policy audit_share_links_admin_update on public.audit_share_links
  for update to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- ============== CREATE RPC ==============
-- The frontend calls this from settings. Returns the token + the
-- canonical URL the founder shares with the auditor.

create or replace function public.create_audit_share_link(
  p_label       text default null,
  p_ttl_days    int  default 30
)
returns table (
  id          uuid,
  token       text,
  label       text,
  expires_at  timestamptz,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_token  text;
  v_id     uuid;
  v_expires timestamptz;
begin
  v_org_id := public.current_org_id();
  if v_org_id is null then
    raise exception 'no active org';
  end if;
  if not public.has_org_role(v_org_id, 'admin') then
    raise exception 'admin role required';
  end if;

  if p_ttl_days is null or p_ttl_days < 1 or p_ttl_days > 365 then
    raise exception 'ttl_days must be between 1 and 365';
  end if;

  v_expires := now() + (p_ttl_days || ' days')::interval;
  v_token   := encode(gen_random_bytes(32), 'base64');
  -- base64url-ish: strip padding + replace + and / with - and _
  v_token   := translate(v_token, '+/=', '-_');

  insert into public.audit_share_links (org_id, token, label, expires_at, created_by)
  values (v_org_id, v_token, p_label, v_expires, auth.uid())
  returning audit_share_links.id, audit_share_links.token,
            audit_share_links.label, audit_share_links.expires_at,
            audit_share_links.created_at
  into v_id, v_token, p_label, v_expires;

  -- audit_log
  insert into public.audit_log (org_id, user_id, action, resource_type, resource_id, metadata)
  values (
    v_org_id, auth.uid(),
    'audit_share_link.created',
    'audit_share_link',
    v_id,
    jsonb_build_object('label', p_label, 'expires_at', v_expires)
  );

  return query select v_id, v_token, p_label, v_expires, now();
end;
$$;

revoke execute on function public.create_audit_share_link(text, int)
  from public, anon;
grant   execute on function public.create_audit_share_link(text, int)
  to authenticated, service_role;

-- ============== REVOKE RPC ==============

create or replace function public.revoke_audit_share_link(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  v_org_id := public.current_org_id();
  if v_org_id is null or not public.has_org_role(v_org_id, 'admin') then
    raise exception 'admin role required';
  end if;

  update public.audit_share_links
     set revoked_at = now()
   where id = p_id
     and org_id = v_org_id
     and revoked_at is null;
  if not found then
    return false;
  end if;

  insert into public.audit_log (org_id, user_id, action, resource_type, resource_id)
  values (v_org_id, auth.uid(), 'audit_share_link.revoked', 'audit_share_link', p_id);

  return true;
end;
$$;

revoke execute on function public.revoke_audit_share_link(uuid)
  from public, anon;
grant   execute on function public.revoke_audit_share_link(uuid)
  to authenticated, service_role;

-- ============== PUBLIC PAYLOAD RPC ==============
-- The /audit/<token> page calls this. Returns the deep evidence
-- bundle if the token is alive, null otherwise. Bumps the access
-- counter on each call. Granted to anon — this is the security
-- boundary.

create or replace function public.get_audit_share_payload(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_link   record;
  v_org    record;
  v_posture jsonb;
  v_findings jsonb;
  v_stats   jsonb;
begin
  -- Resolve the token. Must exist, not be revoked, not expired.
  select id, org_id, label, expires_at, revoked_at, access_count, last_accessed_at
    into v_link
  from public.audit_share_links
  where token = p_token
    and revoked_at is null
    and expires_at > now()
  limit 1;

  if v_link.id is null then
    return null;
  end if;

  -- Org metadata.
  select id, name, slug, created_at
    into v_org
  from public.organizations
  where id = v_link.org_id;

  -- Compliance posture — full per-control verdicts (deeper than the
  -- trust page's per-framework summary).
  select jsonb_agg(
    jsonb_build_object(
      'framework',     framework,
      'control_id',    control_id,
      'verdict',       verdict,
      'summary',       evidence_summary,
      'observed_at',   observed_at,
      'detail',        detail
    )
    order by framework, control_id
  )
  into v_posture
  from public.org_compliance_posture_v
  where org_id = v_link.org_id;

  -- Recent findings (last 90 days, top 50). Title + severity +
  -- status — no PoC payload to keep the payload light.
  select jsonb_agg(
    jsonb_build_object(
      'id',         id,
      'title',      title,
      'severity',   severity,
      'status',     status,
      'created_at', created_at,
      'triaged_at', triaged_at
    )
    order by created_at desc
  )
  into v_findings
  from (
    select id, title, severity, status, created_at, triaged_at
    from public.findings
    where org_id = v_link.org_id
      and created_at >= now() - interval '90 days'
    order by created_at desc
    limit 50
  ) f;

  -- Headline stats.
  select jsonb_build_object(
    'open_critical',     (select count(*) from public.findings where org_id = v_link.org_id and status = 'open' and severity = 'critical'),
    'open_high',         (select count(*) from public.findings where org_id = v_link.org_id and status = 'open' and severity = 'high'),
    'total_findings',    (select count(*) from public.findings where org_id = v_link.org_id),
    'total_scans',       (select count(*) from public.scans    where org_id = v_link.org_id),
    'monitoring_since',  v_org.created_at
  )
  into v_stats;

  return jsonb_build_object(
    'org', jsonb_build_object(
      'name', v_org.name,
      'slug', v_org.slug
    ),
    'link', jsonb_build_object(
      'label',           v_link.label,
      'expires_at',      v_link.expires_at,
      'access_count',    v_link.access_count
    ),
    'compliance',  coalesce(v_posture,  '[]'::jsonb),
    'findings',    coalesce(v_findings, '[]'::jsonb),
    'stats',       v_stats,
    'generated_at', now()
  );
end;
$$;

revoke execute on function public.get_audit_share_payload(text) from public;
grant   execute on function public.get_audit_share_payload(text)
  to anon, authenticated, service_role;

-- ============== ACCESS BUMP ==============
-- Separate function so the GET-payload path can be `stable` (read-only)
-- while the access-counter increment is a normal write. The API route
-- calls this after rendering, so a noisy crawler doesn't bump every
-- time. Also writes an audit_log entry.

create or replace function public.record_audit_share_access(
  p_token text,
  p_ip    text  default null,
  p_ua    text  default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
begin
  select id, org_id into v_link
  from public.audit_share_links
  where token = p_token
    and revoked_at is null
    and expires_at > now();

  if v_link.id is null then
    return false;
  end if;

  update public.audit_share_links
     set access_count = access_count + 1,
         last_accessed_at = now()
   where id = v_link.id;

  insert into public.audit_log (org_id, user_id, action, resource_type, resource_id, metadata)
  values (
    v_link.org_id, null,
    'audit_share_link.accessed',
    'audit_share_link',
    v_link.id,
    jsonb_build_object('ip', p_ip, 'user_agent', p_ua)
  );

  return true;
end;
$$;

revoke execute on function public.record_audit_share_access(text, text, text) from public;
grant   execute on function public.record_audit_share_access(text, text, text)
  to anon, authenticated, service_role;
