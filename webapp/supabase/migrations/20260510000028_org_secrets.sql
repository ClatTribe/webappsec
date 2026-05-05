-- §19.1 Tier 1 item 10 — per-org STRIX_* API keys for engine recon tools.
--
-- The fork (wrapper-wishlist.md §5) registers 5 key-gated tools that
-- silently fail-open without keys:
--
--   STRIX_GITHUB_TOKEN          → code-search recon (#24) + secret-leak detection
--   STRIX_BING_KEY              → SaaS leak discovery (#28)
--   STRIX_SECURITYTRAILS_KEY    → passive DNS history (preferred)
--   STRIX_VIRUSTOTAL_KEY        → passive DNS history (fallback)
--   STRIX_VIEWDNS_KEY           → reverse-IP optional secondary (#23)
--
-- Today the worker has no way to source these per-org. This migration
-- generalises the existing `organizations.llm_api_key_secret_id` pattern
-- into a key/value table so adding a new STRIX env var is a row, not a
-- schema change. The vault stores the actual secret; this table only
-- holds the secret_id pointer.

create table if not exists public.org_secrets (
  org_id    uuid not null references public.organizations(id) on delete cascade,
  key       text not null
            check (key in (
              'STRIX_GITHUB_TOKEN',
              'STRIX_BING_KEY',
              'STRIX_SECURITYTRAILS_KEY',
              'STRIX_VIRUSTOTAL_KEY',
              'STRIX_VIEWDNS_KEY'
            )),
  secret_id uuid not null,                         -- pointer to vault.secrets
  set_at    timestamptz not null default now(),
  set_by    uuid references auth.users,
  primary key (org_id, key)
);

-- Read-only for org members so the settings UI can render which keys are
-- configured. The vault secret value never leaves the worker. Insert /
-- update / delete restricted to owner+admin (enforced via the API route's
-- explicit role check + this table's policies).

alter table public.org_secrets enable row level security;

-- Members see which keys are set (presence + set_at, not the value).
create policy org_secrets_member_read on public.org_secrets
  for select to authenticated using (org_id = public.current_org_id());

-- Owner+admin can write; the API route enforces this via RLS by
-- attempting the write under the user-context client. Members get a
-- 403 from the policy check.
create policy org_secrets_admin_write on public.org_secrets
  for all to authenticated
  using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.user_id = auth.uid()
        and m.org_id = org_secrets.org_id
        and m.role in ('owner','admin')
    )
  )
  with check (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.user_id = auth.uid()
        and m.org_id = org_secrets.org_id
        and m.role in ('owner','admin')
    )
  );

-- ============== Worker decrypt RPC ==============
--
-- Returns the org's full set of decrypted STRIX_* keys as a jsonb map.
-- Worker calls this once per scan and forwards each key as a sandbox
-- env var. SECURITY DEFINER + service-role-only — exactly the same
-- isolation as worker_decrypt_org_llm_key (audit trail similar).
--
-- Returns an empty object when no keys are configured (engine handles
-- absence by failing-open per-tool with an error_reason). On any vault
-- read failure we log via audit_log and return whatever we successfully
-- decrypted — partial success beats whole-scan failure.

create or replace function public.worker_decrypt_org_secrets(p_scan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_org_id uuid;
  v_keys jsonb := '{}'::jsonb;
  r record;
  v_plaintext text;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_decrypt_org_secrets requires service role';
  end if;

  select s.org_id into v_org_id
    from public.scans s
   where s.id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  for r in
    select key, secret_id
      from public.org_secrets
     where org_id = v_org_id
  loop
    begin
      select decrypted_secret into v_plaintext
        from vault.decrypted_secrets
       where id = r.secret_id;
      if v_plaintext is not null then
        v_keys := v_keys || jsonb_build_object(r.key, v_plaintext);
      end if;
    exception
      when others then
        -- Don't bring the whole scan down because of one bad secret.
        -- Audit the failure and continue with the keys we have.
        insert into public.audit_log (org_id, user_id, action, resource_type, resource_id, metadata)
        values (v_org_id, null, 'org.secret.decrypt_failed', 'org_secret', r.secret_id::text,
                jsonb_build_object('key', r.key, 'error', SQLERRM));
    end;
  end loop;

  return v_keys;
end;
$$;

revoke execute on function public.worker_decrypt_org_secrets(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_decrypt_org_secrets(uuid)
  to service_role;
