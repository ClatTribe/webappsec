-- Add audit + explicit scan-existence check to worker_decrypt_org_llm_key.
--
-- The original (in 20260427000003_vault_helpers.sql) only verified the service
-- role and silently produced "org has no LLM API key configured" when the
-- scan_id didn't exist (because the JOIN returned no rows and v_secret_id
-- ended up null). It also wrote no audit_log row, while its sibling
-- worker_decrypt_integration writes one on every decrypt call.
--
-- This migration brings the two functions to parity: every LLM-key decrypt
-- now produces an `llm_key.use` audit_log entry, and a missing scan raises
-- the right error.

create or replace function public.worker_decrypt_org_llm_key(p_scan_id uuid)
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
    raise exception 'worker_decrypt_org_llm_key requires service role';
  end if;

  select s.org_id, o.llm_api_key_secret_id
    into v_org_id, v_secret_id
  from public.scans s
  join public.organizations o on o.id = s.org_id
  where s.id = p_scan_id;

  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;
  if v_secret_id is null then
    raise exception 'org has no LLM API key configured';
  end if;

  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets
  where id = v_secret_id;

  insert into public.audit_log (org_id, action, resource_type, resource_id, metadata)
  values (
    v_org_id, 'llm_key.use', 'organization', v_org_id::text,
    jsonb_build_object('scan_id', p_scan_id)
  );

  return v_plaintext;
end;
$$;

revoke execute on function public.worker_decrypt_org_llm_key(uuid) from public, anon, authenticated;
grant execute on function public.worker_decrypt_org_llm_key(uuid) to service_role;
