-- Phase A — scan input completeness. Coverage gaps from the
-- "security & compliance engineer for developers" audit.
--
-- Three related schema additions plus one new RPC:
--
--   A1: Auth credentials on scan create + remembered per-target
--       defaults. The engine accepts --auth-bearer / --auth-cookie /
--       --auth-basic / --header / --login-creds. Without these the
--       wrapper can only scan unauthenticated surfaces — capping
--       coverage at ~30% of any real app and rendering the new `api`
--       target type effectively unusable.
--
--   A2: targets.integration_id — link a repository target to the
--       GitHub integration whose OAuth token should clone it. Today
--       the worker has no way to pull private repos.
--
--   A6 + A7 + A8: per-scan exclude_paths, rate_limit_qps,
--       export_formats, seed_urls — engine flags the worker accepts
--       on the CLI but the wrapper never surfaces.
--
-- Auth credentials are sensitive — stored in Supabase Vault and
-- referenced by `auth_secret_id`. The plaintext shape depends on the
-- auth method:
--   bearer       → "<token>"
--   cookie       → "k=v; k2=v2"
--   basic        → "user:pass"
--   login_creds  → "email:user@x.com:pass:hunter2" (engine PR #156)
--   header       → JSON: {"headers": ["X-Org: foo", "X-Trace: bar"]}
--
-- The worker decrypts via worker_decrypt_scan_auth which mirrors the
-- security model of worker_decrypt_integration: service-role only,
-- per-scan org check.

-- ============================================================================
-- targets — auth defaults + integration link
-- ============================================================================

alter table public.targets
  -- Default auth method for this target. NULL means "no auth"; the
  -- scan form pre-fills from this and lets the user override per
  -- scan. The user can flip "Save as default for this target" to
  -- persist back.
  add column if not exists auth_method text
    check (
      auth_method is null
      or auth_method in ('none', 'bearer', 'cookie', 'basic', 'header', 'login_creds')
    ),
  add column if not exists auth_secret_id uuid references vault.secrets on delete set null,
  -- Repository-only: which GitHub / GitLab / Bitbucket integration
  -- (active OAuth token) the worker should use to clone this target.
  -- Lets us scan private repos without forcing a personal-access-token
  -- copy-paste flow.
  add column if not exists integration_id uuid references public.integrations on delete set null;

create index if not exists targets_integration on public.targets (integration_id)
  where integration_id is not null;

-- ============================================================================
-- scans — per-scan overrides + new engine flags
-- ============================================================================

alter table public.scans
  add column if not exists auth_method text
    check (
      auth_method is null
      or auth_method in ('none', 'bearer', 'cookie', 'basic', 'header', 'login_creds')
    ),
  add column if not exists auth_secret_id uuid references vault.secrets on delete set null,
  -- A6 — repeatable --exclude-path entries. Glob patterns the agent
  -- must skip. Production-traffic safety knob ("don't probe /admin/*").
  add column if not exists exclude_paths text[],
  -- A6 — --rate-limit <qps> outbound cap. Live engines respect this.
  add column if not exists rate_limit_qps int
    check (rate_limit_qps is null or (rate_limit_qps > 0 and rate_limit_qps <= 1000)),
  -- A7 — --export-format value(s). Engine accepts:
  --   vanta, drata, hyperproof, secureframe, servicenow, generic.
  -- Stored as a text[] to allow N exports per scan.
  add column if not exists export_formats text[],
  -- A8 — --seed-url repeatable entries; pre-seed the crawler with
  -- specific URLs rather than just the bare host.
  add column if not exists seed_urls text[];

-- ============================================================================
-- RPC: worker decrypts scan auth (mirrors worker_decrypt_integration)
-- ============================================================================
--
-- The worker calls this once at scan start. The function returns
-- (auth_method, plaintext) where auth_method comes from the scan
-- override OR the parent target's default, and plaintext is decrypted
-- from the matching vault secret.
--
-- Returns NULL auth_method when neither the scan nor the target has
-- one configured (no auth on this scan — same shape as
-- worker_decrypt_integration's "no integration" path).

create or replace function public.worker_decrypt_scan_auth(p_scan_id uuid)
returns table (auth_method text, plaintext text)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_scan_org uuid;
  v_scan_target_id uuid;
  v_scan_method text;
  v_scan_secret uuid;
  v_target_method text;
  v_target_secret uuid;
  v_method text;
  v_secret uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_decrypt_scan_auth requires service role';
  end if;

  -- Qualify column names so they don't collide with the function's
  -- return-column declarations (auth_method, plaintext).
  select s.org_id, s.target_id, s.auth_method, s.auth_secret_id
    into v_scan_org, v_scan_target_id, v_scan_method, v_scan_secret
  from public.scans s
  where s.id = p_scan_id;

  if v_scan_org is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  -- Fall through: prefer the scan override; otherwise the target's
  -- default. Either may be NULL — that's the "no auth" path.
  if v_scan_method is not null then
    v_method := v_scan_method;
    v_secret := v_scan_secret;
  elsif v_scan_target_id is not null then
    select tg.auth_method, tg.auth_secret_id
      into v_target_method, v_target_secret
    from public.targets tg
    where tg.id = v_scan_target_id and tg.org_id = v_scan_org;
    v_method := v_target_method;
    v_secret := v_target_secret;
  end if;

  -- 'none' is an explicit "no auth, even if a default exists" signal;
  -- treat as no decrypt needed.
  if v_method is null or v_method = 'none' or v_secret is null then
    return query select v_method, null::text;
    return;
  end if;

  -- Supabase Vault exposes decryption via the `vault.decrypted_secrets`
  -- view; the original `decrypted_secret(secret_id)` function used to
  -- be the Vault interface but is no longer exposed. Mirrors the
  -- pattern in migrations 003 / 008 (worker_decrypt_integration).
  declare
    v_plaintext text;
  begin
    select decrypted_secret into v_plaintext
    from vault.decrypted_secrets
    where id = v_secret;
    return query select v_method, v_plaintext;
  end;
end;
$$;

revoke execute on function public.worker_decrypt_scan_auth(uuid) from public, anon, authenticated;
grant   execute on function public.worker_decrypt_scan_auth(uuid) to service_role;

-- ============================================================================
-- create_scan_with_targets — bump signature for the new optional fields
-- ============================================================================
--
-- Adds 6 trailing optional params: auth_method, auth_secret_id,
-- exclude_paths, rate_limit_qps, export_formats, seed_urls. Same
-- drop-then-create pattern as migrations 026 / 033 / 034 / 035 to
-- avoid PGRST203 ambiguity.

drop function if exists public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer, jsonb
);

create or replace function public.create_scan_with_targets(
  p_org_id          uuid,
  p_run_name        text,
  p_scan_mode       text,
  p_scope_mode      text,
  p_diff_base       text,
  p_instruction_text text,
  p_target_id       uuid,
  p_targets         jsonb,
  p_integration_ids uuid[],
  p_dns_only        boolean default false,
  p_branch          text default null,
  p_max_cost        numeric default null,
  p_max_input_tokens integer default null,
  p_imports         jsonb default null,
  -- Phase A additions
  p_auth_method     text default null,
  p_auth_secret_id  uuid default null,
  p_exclude_paths   text[] default null,
  p_rate_limit_qps  integer default null,
  p_export_formats  text[] default null,
  p_seed_urls       text[] default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_scan_id uuid;
  v_target jsonb;
  v_int uuid;
  v_idx int := 0;
  v_import jsonb;
  v_path text;
begin
  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    raise exception 'at least one target required';
  end if;

  if p_imports is not null and jsonb_typeof(p_imports) = 'array' then
    for v_import in select jsonb_array_elements(p_imports)
    loop
      v_path := v_import->>'storage_path';
      if v_path is null or v_path = ''
        or split_part(v_path, '/', 1) <> p_org_id::text
      then
        raise exception 'import storage_path must start with org_id: %', v_path;
      end if;
    end loop;
  end if;

  -- A1 — if a scan-level auth_secret_id is supplied, defence-in-depth
  -- check that the secret was just minted (we can't read vault from
  -- here without owner context, so we just rely on the API route's
  -- audit trail). Same pattern as p_integration_ids — the wrapper API
  -- is the authorisation boundary; the RPC trusts it.

  insert into public.scans (
    org_id, user_id, target_id, run_name, status, scan_mode, scope_mode,
    diff_base, instruction_text, dns_only, branch, max_cost, max_input_tokens,
    imports,
    auth_method, auth_secret_id, exclude_paths, rate_limit_qps,
    export_formats, seed_urls
  )
  values (
    p_org_id, auth.uid(), p_target_id, p_run_name, 'queued', p_scan_mode,
    p_scope_mode, p_diff_base, p_instruction_text, coalesce(p_dns_only, false),
    nullif(trim(p_branch), ''),
    case when p_max_cost is not null and p_max_cost > 0 then p_max_cost else null end,
    case when p_max_input_tokens is not null and p_max_input_tokens > 0 then p_max_input_tokens else null end,
    case when p_imports is not null and jsonb_typeof(p_imports) = 'array' and jsonb_array_length(p_imports) > 0
         then p_imports else null end,
    p_auth_method, p_auth_secret_id,
    -- Drop empties / zeros so the worker can check "is this set?"
    -- with a single null check rather than null-or-empty-or-zero.
    nullif(array_remove(coalesce(p_exclude_paths, '{}'::text[]), ''), '{}'),
    case when p_rate_limit_qps is not null and p_rate_limit_qps > 0 then p_rate_limit_qps else null end,
    nullif(array_remove(coalesce(p_export_formats, '{}'::text[]), ''), '{}'),
    nullif(array_remove(coalesce(p_seed_urls, '{}'::text[]), ''), '{}')
  )
  returning id into v_scan_id;

  for v_target in select jsonb_array_elements(p_targets)
  loop
    v_idx := v_idx + 1;
    insert into public.scan_targets (scan_id, type, value, workspace_subdir)
    values (
      v_scan_id,
      v_target->>'type',
      v_target->>'value',
      coalesce(v_target->>'workspace_subdir', 'target_' || v_idx)
    );
  end loop;

  if p_integration_ids is not null and array_length(p_integration_ids, 1) > 0 then
    foreach v_int in array p_integration_ids
    loop
      insert into public.scan_integrations (scan_id, integration_id)
      values (v_scan_id, v_int);
    end loop;
  end if;

  return v_scan_id;
end;
$$;

revoke execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer, jsonb,
  text, uuid, text[], integer, text[], text[]
) from public, anon;
grant   execute on function public.create_scan_with_targets(
  uuid, text, text, text, text, text, uuid, jsonb, uuid[], boolean, text, numeric, integer, jsonb,
  text, uuid, text[], integer, text[], text[]
) to authenticated, service_role;
