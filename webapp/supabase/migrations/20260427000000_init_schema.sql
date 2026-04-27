-- Strix web app — initial schema.
-- All tenant-scoped tables carry org_id; RLS is enabled in a later migration.

-- =================== EXTENSIONS ===================
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- =================== IDENTITY ===================

-- auth.users is provided by Supabase Auth. We extend with a profile row.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  plan text not null default 'free' check (plan in ('free','pro','enterprise')),
  llm_provider text,                                -- e.g. 'openai/gpt-5.4'
  llm_api_key_secret_id uuid,                       -- pointer to vault.secrets
  created_at timestamptz not null default now()
);

create table public.org_members (
  user_id uuid not null references auth.users on delete cascade,
  org_id  uuid not null references public.organizations on delete cascade,
  role    text not null check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index org_members_org on public.org_members(org_id);

-- =================== INTEGRATIONS ===================

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  type text not null check (type in ('github','gitlab','aws','azure','gcp','k8s','webhook')),
  name text not null,
  metadata jsonb not null default '{}'::jsonb,      -- non-secret hints (login, account_id, etc.)
  vault_secret_id uuid not null,                    -- pointer to vault.secrets
  status text not null default 'active' check (status in ('active','revoked','expired')),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index integrations_org on public.integrations(org_id);

-- =================== SCANS ===================

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid not null references auth.users,
  run_name text not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  scan_mode text not null default 'standard' check (scan_mode in ('quick','standard','deep')),
  scope_mode text default 'auto' check (scope_mode in ('auto','diff','full')),
  diff_base text,
  instruction_text text,
  llm_provider text,
  total_input_tokens bigint default 0,
  total_output_tokens bigint default 0,
  total_cost numeric(10,4) default 0,
  agents_count int default 0,
  exit_code int,
  artifact_prefix text,                              -- supabase storage path prefix
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index scans_org_status on public.scans(org_id, status);
create index scans_org_created on public.scans(org_id, created_at desc);

create table public.scan_targets (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans on delete cascade,
  type text not null check (type in ('local_code','repository','web_application','domain','ip_address')),
  value text not null,
  workspace_subdir text,
  source_integration_id uuid references public.integrations
);

create index scan_targets_scan on public.scan_targets(scan_id);

create table public.scan_integrations (
  scan_id uuid not null references public.scans on delete cascade,
  integration_id uuid not null references public.integrations on delete cascade,
  primary key (scan_id, integration_id)
);

-- =================== LIVE EVENTS (drives Realtime) ===================

create table public.scan_events (
  id bigserial primary key,
  scan_id uuid not null references public.scans on delete cascade,
  org_id  uuid not null,                             -- denormalized for RLS perf
  event_type text not null,                          -- agent.created | tool.execution_started | finding.created | status.changed | log | ...
  payload jsonb,
  created_at timestamptz not null default now()
);

create index scan_events_scan_id on public.scan_events(scan_id, id);
create index scan_events_org on public.scan_events(org_id);

-- =================== FINDINGS ===================

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans on delete cascade,
  org_id uuid not null,                              -- denormalized for RLS perf and cross-scan queries
  vuln_id text not null,                             -- e.g. 'vuln-0001'
  title text not null,
  severity text not null check (severity in ('critical','high','medium','low','info')),
  cvss numeric(3,1),
  cvss_vector text,
  cwe text,
  cve text,
  target text,
  endpoint text,
  method text,
  description_md text,
  technical_analysis_md text,
  poc_md text,
  impact_md text,
  remediation_md text,
  affected_files jsonb,
  status text not null default 'open' check (status in ('open','triaged_real','false_positive','wont_fix','fixed')),
  triaged_by uuid references auth.users,
  triaged_at timestamptz,
  triage_notes text,
  fingerprint text,                                  -- stable hash for dedupe across scans
  created_at timestamptz not null default now()
);

create index findings_scan on public.findings(scan_id);
create index findings_org_severity on public.findings(org_id, severity, created_at desc);
create index findings_fingerprint on public.findings(org_id, fingerprint);

-- =================== AUDIT ===================

create table public.audit_log (
  id bigserial primary key,
  org_id uuid not null,
  user_id uuid,                                      -- null for worker / system actions
  action text not null,                              -- 'integration.create', 'scan.start', 'integration.use', etc.
  resource_type text,
  resource_id text,
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_org_time on public.audit_log(org_id, created_at desc);

-- =================== API TOKENS ===================

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid references auth.users,
  name text not null,
  hashed_token text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index api_tokens_org on public.api_tokens(org_id);

-- =================== AUTO PROFILE ON SIGNUP ===================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
