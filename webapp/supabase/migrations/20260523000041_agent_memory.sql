-- Per-org agent memory — AISecurityEngineerUXRoadmap.md §9 / §13.2.
--
-- The wrapper's moat over generic DAST tools: each org's agent presence
-- carries continuous memory of what the org runs, who its people are, what
-- decisions it has already made, what it has dismissed and why, and what
-- it's preparing for. The chat handler reads this on every turn; the
-- digest composer reads it daily; the autonomy slider reads + writes it
-- on every adjustment.
--
-- Three tables, all RLS-scoped by org_id:
--
--   1. agent_memory_facts — small, structured key-value beliefs about the org.
--      Examples: scope='stack'   key='framework'    value='nextjs+supabase'
--                scope='team'    key='lead'         value='@alice'
--                scope='comp'    key='soc2_audit'   value={"date":"2026-03-15","auditor":"AnAuditor LLC"}
--                scope='supp'    key='cf_waf_headers' value={"reason":"behind Cloudflare WAF","added_at":"..."}
--
--      Facts are versioned via `superseded_by` (a new fact pointing at the
--      old one) — preserves provenance for auditing without destructive
--      overwrites. The unique key `(org_id, scope, key) where superseded_by
--      is null` keeps "current facts" cheap to read.
--
--   2. agent_memory_episodes — append-only log of meaningful events the
--      agent participated in. Examples: 'finding_dismissed', 'fix_applied',
--      'scan_run', 'rule_added', 'autonomy_adjusted', 'compliance_status_changed'.
--      Carries enough payload + rationale that the retrieval layer can
--      surface relevant episodes back to the agent ("you marked the
--      /api/health SSRF as known-intentional three months ago").
--
--   3. agent_memory_preferences — single row per org. Autonomy slider
--      state, agent voice/tone knobs, per-channel routing decisions,
--      digest schedule. Seeded on org creation by trigger so the chat
--      handler can always do `select autonomy from ... where org_id=$1`
--      and get a row back without coalesce-or-default branching.
--
-- All three tables are RLS-keyed to `org_id = public.current_org_id()`,
-- matching every other tenant-scoped table in this repo. Service-role
-- writes from the worker bypass RLS, same as findings/scan_events.

-- ============== 1. FACTS ==============

create table if not exists public.agent_memory_facts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete cascade,
  scope         text not null check (length(scope) between 1 and 64),
  key           text not null check (length(key) between 1 and 128),
  value         jsonb not null,
  source        text not null check (source in (
                  'told_by_user',       -- explicit user statement in chat / settings
                  'inferred_from_repo', -- worker read package.json / framework markers
                  'inferred_from_scan', -- derived from scan output (e.g. tech-stack fingerprint)
                  'derived_from_audit', -- aggregated from compliance evidence
                  'agent_decision'      -- agent's own conclusion / chosen default
                )),
  confidence    numeric not null default 1.0 check (confidence between 0 and 1),
  superseded_by uuid references public.agent_memory_facts(id) on delete set null,
  created_by    uuid references auth.users on delete set null,
  created_at    timestamptz not null default now()
);

create unique index if not exists agent_memory_facts_current
  on public.agent_memory_facts (org_id, scope, key)
  where superseded_by is null;

create index if not exists agent_memory_facts_org_scope
  on public.agent_memory_facts (org_id, scope)
  where superseded_by is null;

comment on table public.agent_memory_facts is
  'Per-org structured beliefs the agent maintains about the customer. '
  'Versioned via superseded_by; current row per (org,scope,key) is the '
  'one where superseded_by is null.';

alter table public.agent_memory_facts enable row level security;

drop policy if exists agent_memory_facts_org_read on public.agent_memory_facts;
create policy agent_memory_facts_org_read on public.agent_memory_facts
  for select to authenticated
  using (org_id = public.current_org_id());

-- Member writes (via UI / agent acting on user's behalf): only same-org rows.
drop policy if exists agent_memory_facts_org_insert on public.agent_memory_facts;
create policy agent_memory_facts_org_insert on public.agent_memory_facts
  for insert to authenticated
  with check (org_id = public.current_org_id());

drop policy if exists agent_memory_facts_org_update on public.agent_memory_facts;
create policy agent_memory_facts_org_update on public.agent_memory_facts
  for update to authenticated
  using (org_id = public.current_org_id());

-- Deletes restricted to admins — facts are part of the org's audit trail.
drop policy if exists agent_memory_facts_admin_delete on public.agent_memory_facts;
create policy agent_memory_facts_admin_delete on public.agent_memory_facts
  for delete to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- ============== 2. EPISODES ==============

create table if not exists public.agent_memory_episodes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete cascade,
  thread_id    uuid,                     -- ref to agent_threads when that table lands (FK deferred to follow-up)
  user_id      uuid references auth.users on delete set null,
  agent_action text not null check (length(agent_action) between 1 and 64),
  payload      jsonb not null default '{}'::jsonb,
  rationale    text,
  created_at   timestamptz not null default now()
);

create index if not exists agent_memory_episodes_org_time
  on public.agent_memory_episodes (org_id, created_at desc);

create index if not exists agent_memory_episodes_org_action
  on public.agent_memory_episodes (org_id, agent_action, created_at desc);

comment on table public.agent_memory_episodes is
  'Per-org append-only log of meaningful agent participations. Retrieval '
  'layer surfaces these back to the chat agent on relevant turns ("you '
  'made this decision 3 months ago for reason X").';

alter table public.agent_memory_episodes enable row level security;

drop policy if exists agent_memory_episodes_org_read on public.agent_memory_episodes;
create policy agent_memory_episodes_org_read on public.agent_memory_episodes
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists agent_memory_episodes_org_insert on public.agent_memory_episodes;
create policy agent_memory_episodes_org_insert on public.agent_memory_episodes
  for insert to authenticated
  with check (org_id = public.current_org_id());

-- Episodes are append-only — no update/delete policies for authenticated.
-- Service role can backfill / amend if needed.

-- ============== 3. PREFERENCES ==============

create table if not exists public.agent_memory_preferences (
  org_id     uuid primary key references public.organizations on delete cascade,
  autonomy   jsonb not null default '{}'::jsonb,
  voice      jsonb not null default '{}'::jsonb,
  channels   jsonb not null default '{}'::jsonb,
  schedule   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);

comment on table public.agent_memory_preferences is
  'Single row per org. Holds the autonomy slider state, voice/tone knobs, '
  'channel routing, and digest schedule. Seeded on org creation; mutated '
  'by user (UI) or by the agent (NL adjustment).';

alter table public.agent_memory_preferences enable row level security;

drop policy if exists agent_memory_preferences_org_read on public.agent_memory_preferences;
create policy agent_memory_preferences_org_read on public.agent_memory_preferences
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists agent_memory_preferences_admin_update on public.agent_memory_preferences;
create policy agent_memory_preferences_admin_update on public.agent_memory_preferences
  for update to authenticated
  using (
    org_id = public.current_org_id()
    and public.has_org_role(org_id, 'admin')
  );

-- ============== 4. SEED ON ORG CREATION ==============
-- The chat handler reads `select autonomy from agent_memory_preferences
-- where org_id=$1` on every turn and expects a row. Seed it the moment
-- the org is created so the handler never has to coalesce-or-default.

create or replace function public.seed_agent_memory_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agent_memory_preferences (
    org_id,
    autonomy,
    voice,
    channels,
    schedule
  )
  values (
    new.id,
    -- Conservative default: ask before any state-changing action.
    -- Per the roadmap §1.6 — orgs start as co-pilot and slide toward
    -- autopilot as trust grows.
    jsonb_build_object(
      'default',          'ask_before_act',
      'auto_fix_severity', null,
      'auto_dismiss',     false,
      'slack_notify',     'always'
    ),
    -- Voice defaults — friendly, mid-verbose.
    jsonb_build_object(
      'tone',      'professional_friendly',
      'verbosity', 'mid',
      'name',      'Strix'
    ),
    jsonb_build_object(),  -- empty until org configures Slack/etc
    -- Digest at 09:00 in the org's local time (UTC stub until org sets tz).
    jsonb_build_object(
      'daily_digest_time', '09:00Z',
      'digest_channels',   to_jsonb(array['in_app']::text[])
    )
  )
  on conflict (org_id) do nothing;
  return new;
end;
$$;

drop trigger if exists organizations_seed_agent_memory on public.organizations;
create trigger organizations_seed_agent_memory
  after insert on public.organizations
  for each row execute function public.seed_agent_memory_preferences();

-- Backfill: ensure every existing org has a preferences row.
insert into public.agent_memory_preferences (org_id, autonomy, voice, channels, schedule)
select
  o.id,
  jsonb_build_object(
    'default',          'ask_before_act',
    'auto_fix_severity', null,
    'auto_dismiss',     false,
    'slack_notify',     'always'
  ),
  jsonb_build_object(
    'tone',      'professional_friendly',
    'verbosity', 'mid',
    'name',      'Strix'
  ),
  jsonb_build_object(),
  jsonb_build_object(
    'daily_digest_time', '09:00Z',
    'digest_channels',   to_jsonb(array['in_app']::text[])
  )
from public.organizations o
where not exists (
  select 1 from public.agent_memory_preferences p where p.org_id = o.id
);

-- ============== 5. REALTIME ==============
-- The autonomy slider UI subscribes to preferences changes so a chat-side
-- NL adjustment ("be more aggressive with dep-CVEs") reflects in the
-- settings view immediately. Episodes feed a live activity stream.
-- Facts are mostly read-on-demand; no realtime subscription needed yet.

alter publication supabase_realtime add table public.agent_memory_preferences;
alter publication supabase_realtime add table public.agent_memory_episodes;
