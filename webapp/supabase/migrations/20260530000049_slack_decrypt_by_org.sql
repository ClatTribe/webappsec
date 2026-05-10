-- Org-id-keyed Slack webhook decrypt RPC.
--
-- The scan-id variant (migration 037) is the path the scan-completion
-- notifier uses — it has a scan_id from the run context. The Phase D
-- chat-bridge worker codepath (migration 048's pg_notify) only has
-- agent_messages.id → thread_id → org_id; no scan context.
--
-- Logic identical to the scan-id variant: pull slack_webhook_secret_id
-- from organizations, decrypt via vault, defensively validate the URL
-- prefix to catch vault drift / forged secrets.

create or replace function public.worker_decrypt_org_slack_webhook_by_org(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_plaintext text;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_decrypt_org_slack_webhook_by_org requires service role';
  end if;

  select slack_webhook_secret_id into v_secret_id
    from public.organizations
   where id = p_org_id;
  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_plaintext
    from vault.decrypted_secrets
   where id = v_secret_id;

  if v_plaintext is null
     or v_plaintext !~ '^https://hooks\.slack\.com/services/'
  then
    return null;
  end if;

  return v_plaintext;
end;
$$;

revoke execute on function public.worker_decrypt_org_slack_webhook_by_org(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_decrypt_org_slack_webhook_by_org(uuid)
  to service_role;
