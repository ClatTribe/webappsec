-- Wrappers around Supabase Vault that:
--  1. Allow callers to create secrets without seeing the underlying vault.secrets schema.
--  2. Enforce org-isolation on read so a stolen service-role key cannot dump all secrets
--     without also forging a scan_id / org_id context.
--
-- vault.create_secret(secret text, name text default null, description text default null)
-- vault.decrypted_secrets is a view that decrypts on-the-fly.

-- Service-role-only: create a secret and return its id.
-- Frontend service-role API routes call this when storing integration creds.
create or replace function public.vault_create_secret(
  p_secret text,
  p_name text,
  p_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  new_id uuid;
begin
  -- Only service role should call this. Authenticated users go through the API route.
  if auth.role() not in ('service_role') then
    raise exception 'vault_create_secret requires service role';
  end if;

  select vault.create_secret(p_secret, p_name, p_description) into new_id;
  return new_id;
end;
$$;

revoke execute on function public.vault_create_secret(text, text, text) from public, anon, authenticated;
grant execute on function public.vault_create_secret(text, text, text) to service_role;

-- Service-role-only: decrypt a secret by id and validate org context.
-- The worker calls this with a scan_id + integration_id so we can confirm the integration
-- actually belongs to the scan's org before returning plaintext.
create or replace function public.worker_decrypt_integration(
  p_scan_id uuid,
  p_integration_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_org_id uuid;
  v_scan_org_id uuid;
  v_secret_id uuid;
  v_plaintext text;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_decrypt_integration requires service role';
  end if;

  select org_id, vault_secret_id
    into v_org_id, v_secret_id
  from public.integrations
  where id = p_integration_id and status = 'active';

  if v_org_id is null then
    raise exception 'integration not found or revoked';
  end if;

  select org_id into v_scan_org_id from public.scans where id = p_scan_id;

  if v_scan_org_id is null or v_scan_org_id <> v_org_id then
    raise exception 'integration does not belong to the scan''s org';
  end if;

  -- Verify the scan also has this integration linked (defense in depth).
  if not exists (
    select 1 from public.scan_integrations
    where scan_id = p_scan_id and integration_id = p_integration_id
  ) then
    raise exception 'integration not linked to scan';
  end if;

  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets
  where id = v_secret_id;

  -- Audit every decrypt call.
  insert into public.audit_log (org_id, action, resource_type, resource_id, metadata)
  values (
    v_org_id, 'integration.use', 'integration', p_integration_id::text,
    jsonb_build_object('scan_id', p_scan_id)
  );

  -- Update last_used_at without disturbing other columns.
  update public.integrations set last_used_at = now() where id = p_integration_id;

  return v_plaintext;
end;
$$;

revoke execute on function public.worker_decrypt_integration(uuid, uuid) from public, anon, authenticated;
grant execute on function public.worker_decrypt_integration(uuid, uuid) to service_role;

-- Decrypt the org-level LLM API key for a scan. Same pattern.
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

  if v_secret_id is null then
    raise exception 'org has no LLM API key configured';
  end if;

  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_plaintext;
end;
$$;

revoke execute on function public.worker_decrypt_org_llm_key(uuid) from public, anon, authenticated;
grant execute on function public.worker_decrypt_org_llm_key(uuid) to service_role;
