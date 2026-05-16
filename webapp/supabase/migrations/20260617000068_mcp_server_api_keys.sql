-- Tier II #8 — MCP server (Model Context Protocol).
--
-- TensorShield exposes a hosted MCP endpoint at /api/mcp so vibe-coders
-- using Cursor / Claude Code / any MCP-aware AI assistant can ask
-- their copilot to "check this for security issues" and get answers
-- backed by *their* org's scans + findings + policies.
--
-- This migration adds the auth layer:
--
--   - public.api_keys             org-scoped Bearer tokens for MCP clients
--   - public.resolve_api_key(...) SECURITY DEFINER function the MCP route
--                                 uses to map a hashed key → org context
--                                 without requiring a Supabase JWT
--
-- Key shape:
--   ts_<prefix>_<random>          (printable to the user once; never
--                                  re-shown — we store only the SHA-256
--                                  hash and the 8-char prefix)
--
-- Scopes (text[]; checked at the JSON-RPC dispatch layer):
--   mcp:read    list findings, list targets, read finding details
--   mcp:scan    kick a scan (resource-intensive — opt-in scope)
--   mcp:review  rule-based security review of a snippet (rate-limited)
--
-- We deliberately do NOT add a `mcp:write` scope today. Writing to
-- triage state, opening PRs, or rotating credentials from an MCP
-- client opens too many "the AI made a mess" foot-guns for v1.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  created_by uuid not null references auth.users on delete cascade,
  -- User-supplied label so a developer can have multiple keys (one
  -- per laptop, one per CI job) and tell them apart in the revoke UI.
  name text not null check (length(name) between 1 and 120),
  -- Visible prefix shown in the UI list — same prefix the developer
  -- saw at mint time, so they can match "which key did I install on
  -- this laptop?" without re-minting.
  key_prefix text not null check (length(key_prefix) between 8 and 32),
  -- SHA-256 hex of the full secret. We use SHA-256 rather than bcrypt
  -- because (a) the secret is high-entropy (32 random bytes), so
  -- offline brute-force isn't the threat model, and (b) we need fast
  -- O(1) lookup for every MCP request. bcrypt's per-request cost
  -- would make MCP latency-sensitive workflows painful.
  key_hash text not null check (length(key_hash) = 64),
  scopes text[] not null default array['mcp:read', 'mcp:scan', 'mcp:review'],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.api_keys is
  'Tier II #8 — org-scoped Bearer tokens for the MCP server at /api/mcp. '
  'Members of an org can mint keys; the MCP route resolves them via '
  'resolve_api_key() (SECURITY DEFINER) to look up org context without '
  'a Supabase JWT.';

create unique index if not exists api_keys_hash on public.api_keys(key_hash);
create index if not exists api_keys_org_active on public.api_keys(org_id)
  where revoked_at is null;
create index if not exists api_keys_org_created on public.api_keys(org_id, created_at desc);

-- ============================================================================
-- RLS — members see their org's keys; admins/owners mint and revoke.
-- ============================================================================

alter table public.api_keys enable row level security;

drop policy if exists api_keys_org_read on public.api_keys;
create policy api_keys_org_read on public.api_keys
  for select using (org_id = public.current_org_id());

drop policy if exists api_keys_org_insert on public.api_keys;
create policy api_keys_org_insert on public.api_keys
  for insert with check (
    org_id = public.current_org_id()
    and created_by = auth.uid()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists api_keys_org_update on public.api_keys;
create policy api_keys_org_update on public.api_keys
  for update using (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- ============================================================================
-- resolve_api_key(p_key_hash text)
--
-- SECURITY DEFINER lookup the MCP route uses on every request. Returns
-- the org_id + scopes + key_id (so we can stamp last_used_at) for an
-- active, non-revoked, non-expired key, or empty rows for any mismatch.
--
-- Why SECURITY DEFINER:
--   The MCP route has no Supabase JWT — the client (Cursor / Claude
--   Code) authenticates with the API key only. We can't go through
--   the auth.uid()-gated RLS path. The function runs as table owner,
--   reads only public.api_keys, and returns the minimum needed to
--   scope subsequent admin-client queries.
--
-- Why we pass the HASH and not the raw key:
--   The wrapper hashes the Bearer token client-side (SHA-256) before
--   the round-trip. The raw secret never touches Postgres logs, the
--   query planner, or pg_stat_statements.
-- ============================================================================

create or replace function public.resolve_api_key(p_key_hash text)
returns table (org_id uuid, scopes text[], key_id uuid)
language sql
security definer
set search_path = public
as $$
  select org_id, scopes, id
    from public.api_keys
   where key_hash = p_key_hash
     and revoked_at is null
     and (expires_at is null or expires_at > now())
   limit 1
$$;

revoke execute on function public.resolve_api_key(text) from public;
grant   execute on function public.resolve_api_key(text) to service_role;

comment on function public.resolve_api_key(text) is
  'Tier II #8 — service-role-only lookup. Used by /api/mcp to map a '
  'SHA-256 of the Bearer token to its org + scopes. Returns no rows '
  'when the key is unknown, expired, or revoked — never raises.';

-- Companion: stamp last_used_at on a key after a successful MCP call.
-- Also SECURITY DEFINER + service-role-only because the MCP context
-- has no JWT.
create or replace function public.touch_api_key(p_key_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.api_keys
     set last_used_at = now()
   where id = p_key_id
$$;

revoke execute on function public.touch_api_key(uuid) from public;
grant   execute on function public.touch_api_key(uuid) to service_role;

comment on function public.touch_api_key(uuid) is
  'Tier II #8 — bumps api_keys.last_used_at. Idempotent; service-role only.';
