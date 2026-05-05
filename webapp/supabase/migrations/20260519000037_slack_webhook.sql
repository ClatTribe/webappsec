-- Tier A — Slack notification on scan completion.
--
-- The async case: operators don't sit on the dashboard. Without a push
-- channel they don't know a critical finding landed. This migration
-- adds a per-org Slack webhook URL stored vault-encrypted, mirrors the
-- `llm_api_key_secret_id` pattern from the init schema, and exposes a
-- `worker_decrypt_org_slack_webhook(p_scan_id)` RPC for the worker.
--
-- Email is intentionally out of scope for this MVP — Slack covers the
-- "engineer in your team chat" use case for the same surface area
-- without the SMTP / SES / Resend account-management overhead.

alter table public.organizations
  add column if not exists slack_webhook_secret_id uuid;

-- Worker-side decrypt RPC. Same shape as worker_decrypt_org_llm_key:
-- service-role-only, takes a scan_id (the worker doesn't know its own
-- org_id at decrypt time), looks up the org's pointer, returns
-- plaintext from vault. Returns null when no webhook is configured —
-- worker treats that as "no notification, scan finishes silently".

create or replace function public.worker_decrypt_org_slack_webhook(p_scan_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_org_id uuid;
  v_secret_id uuid;
  v_plaintext text;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_decrypt_org_slack_webhook requires service role';
  end if;

  select s.org_id, o.slack_webhook_secret_id
    into v_org_id, v_secret_id
    from public.scans s
    join public.organizations o on o.id = s.org_id
   where s.id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;
  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_plaintext
    from vault.decrypted_secrets
   where id = v_secret_id;

  -- Defensive validation. Slack webhook URLs are always
  -- https://hooks.slack.com/services/... — anything else is either a
  -- vault drift or a forged secret. Returning null falls back to the
  -- "no notification" path rather than POSTing to an unintended host.
  if v_plaintext is null
     or v_plaintext !~ '^https://hooks\.slack\.com/services/'
  then
    return null;
  end if;

  return v_plaintext;
end;
$$;

revoke execute on function public.worker_decrypt_org_slack_webhook(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_decrypt_org_slack_webhook(uuid)
  to service_role;
