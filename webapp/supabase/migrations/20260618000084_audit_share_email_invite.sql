-- Auditor portal — invite-by-email.
--
-- Migration 054 shipped shareable-URL audit links: the founder
-- creates a token-bearing URL and pastes it into an email manually.
-- Real-world auditors expect "send to auditor@firm.com, they get a
-- magic link with their name on it." This PR adds the recipient
-- columns + a single-shot RPC the route can call to do both halves
-- (create the link + return a payload the email-sender consumes).
--
-- Storage model: optional `recipient_email` + `recipient_label` on
-- the existing `audit_share_links` table. URL-only links (no
-- recipient) keep working unchanged. When recipient_email is set,
-- each access via `record_audit_share_access` includes the email
-- in the audit_log metadata so "who's been looking at our evidence
-- this week" answers itself.

alter table public.audit_share_links
  add column if not exists recipient_email text
    check (recipient_email is null or recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists recipient_label text
    check (recipient_label is null or length(recipient_label) between 1 and 200);

create index if not exists audit_share_links_recipient
  on public.audit_share_links (org_id, recipient_email)
  where recipient_email is not null and revoked_at is null;

comment on column public.audit_share_links.recipient_email is
  'When set, this share link was created for a specific auditor. '
  'Each access stamps the email into audit_log.metadata so the org '
  'can see "auditor@firm.com viewed our trust page on date X".';

-- ============================================================================
-- invite_audit_share — SECURITY DEFINER, single-shot create-for-email
-- ============================================================================
--
-- The /api/orgs/[id]/audit-links/invite route calls this to mint a
-- token tied to a specific recipient. Returns the new link's id,
-- token, and the canonical URL the email body should embed.
-- The route then hands the payload to lib/email-send for delivery.

create or replace function public.invite_audit_share(
  p_recipient_email text,
  p_recipient_label text default null,
  p_ttl_days        int  default 30
)
returns table (
  id          uuid,
  token       text,
  recipient_email text,
  recipient_label text,
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
  if p_recipient_email is null or length(trim(p_recipient_email)) = 0 then
    raise exception 'recipient_email is required';
  end if;

  v_expires := now() + (p_ttl_days || ' days')::interval;
  v_token   := encode(gen_random_bytes(32), 'base64');
  v_token   := translate(v_token, '+/=', '-_');

  insert into public.audit_share_links (
    org_id, token, label, expires_at, created_by,
    recipient_email, recipient_label
  )
  values (
    v_org_id, v_token,
    coalesce(p_recipient_label, p_recipient_email),
    v_expires, auth.uid(),
    lower(trim(p_recipient_email)),
    p_recipient_label
  )
  returning audit_share_links.id, audit_share_links.token,
            audit_share_links.recipient_email,
            audit_share_links.recipient_label,
            audit_share_links.expires_at,
            audit_share_links.created_at
  into v_id, v_token, p_recipient_email, p_recipient_label, v_expires, id;

  insert into public.audit_log (
    org_id, user_id, action, resource_type, resource_id, metadata
  ) values (
    v_org_id, auth.uid(),
    'audit_share_link.invited',
    'audit_share_link',
    v_id,
    jsonb_build_object(
      'recipient_email', p_recipient_email,
      'recipient_label', p_recipient_label,
      'expires_at', v_expires
    )
  );

  return query select v_id, v_token, p_recipient_email, p_recipient_label,
                      v_expires, now();
end;
$$;

revoke execute on function public.invite_audit_share(text, text, int)
  from public, anon;
grant execute on function public.invite_audit_share(text, text, int)
  to authenticated, service_role;

-- ============================================================================
-- record_audit_share_access — extended to capture recipient_email
-- ============================================================================
--
-- The existing function (migration 054) records access events. We
-- extend its audit_log metadata to include the link's
-- recipient_email when set, so the org's auditor portal can answer
-- "who has accessed our evidence" by recipient identity, not just
-- IP. Function signature is unchanged — additive metadata only.

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
  select id, org_id, recipient_email, recipient_label
    into v_link
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

  insert into public.audit_log (
    org_id, user_id, action, resource_type, resource_id, metadata
  ) values (
    v_link.org_id, null,
    'audit_share_link.accessed',
    'audit_share_link',
    v_link.id,
    jsonb_build_object(
      'ip', p_ip,
      'user_agent', p_ua,
      'recipient_email', v_link.recipient_email,
      'recipient_label', v_link.recipient_label
    )
  );

  return true;
end;
$$;

revoke execute on function public.record_audit_share_access(text, text, text) from public;
grant   execute on function public.record_audit_share_access(text, text, text)
  to anon, authenticated, service_role;
