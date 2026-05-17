-- Per-org conversational shell — AISecurityEngineerUXRoadmap.md §13.1.
--
-- The chat surface where each org's people interact with their slice of the
-- platform. Two tables — threads (conversation containers) and messages
-- (typed-block payloads) — both RLS-scoped by org_id and added to the
-- realtime publication so the frontend can subscribe per active org.
--
-- The org_id is denormalised onto agent_messages (in addition to thread_id)
-- so realtime subscriptions can filter on org_id without joining. This is
-- the cheap insurance against a future bug in the join path leaking other
-- orgs' messages into a user's realtime channel.
--
-- Service-role writes from the worker (finding-driven chat messages, daily
-- digests, autonomy adjustments) bypass RLS — same pattern as findings +
-- scan_events. The worker-write paths land in follow-up PRs; this migration
-- is schema + RLS only.
--
-- agent_memory_episodes.thread_id can finally point at a real table; we
-- backfill nothing (episodes pre-dating threads will keep thread_id=NULL).

-- ============== 1. THREADS ==============

create table if not exists public.agent_threads (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  user_id         uuid references auth.users on delete set null,
  title           text,                          -- agent-generated; mutable
  -- Soft binding to a finding/scan/asset/PR/incident the thread is about.
  -- Examples: {"kind":"finding","id":"<uuid>"} | {"kind":"asset","id":"<uuid>"}
  -- | {"kind":"onboarding"} | {"kind":"daily_digest","date":"2026-05-23"}.
  context         jsonb,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists agent_threads_org_recent
  on public.agent_threads (org_id, last_message_at desc)
  where archived = false;

create index if not exists agent_threads_org_user
  on public.agent_threads (org_id, user_id)
  where archived = false;

comment on table public.agent_threads is
  'Per-org chat thread. Soft-binds to a finding/scan/asset/onboarding via '
  'context jsonb. last_message_at maintained by trigger on agent_messages.';

alter table public.agent_threads enable row level security;

drop policy if exists agent_threads_org_read on public.agent_threads;
create policy agent_threads_org_read on public.agent_threads
  for select to authenticated
  using (org_id = public.current_org_id());

drop policy if exists agent_threads_org_insert on public.agent_threads;
create policy agent_threads_org_insert on public.agent_threads
  for insert to authenticated
  with check (org_id = public.current_org_id());

drop policy if exists agent_threads_org_update on public.agent_threads;
create policy agent_threads_org_update on public.agent_threads
  for update to authenticated
  using (org_id = public.current_org_id());

-- ============== 2. MESSAGES ==============

create table if not exists public.agent_messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references public.agent_threads on delete cascade,
  -- Denormalised from agent_threads.org_id so realtime can filter without join.
  -- Kept consistent via trigger agent_messages_set_org_id (BEFORE INSERT).
  org_id          uuid not null references public.organizations on delete cascade,
  role            text not null check (role in ('user','agent','system','tool')),
  -- Typed AgentBlock[] per AISecurityEngineerUXRoadmap.md §11. Wrapper
  -- renders unknown block types as collapsed JSON with a fallback note,
  -- so adding a new block type doesn't require a frontend deploy.
  blocks          jsonb not null default '[]'::jsonb,
  -- Citations into per-row evidence: finding_id, scan_id, scan_event_id,
  -- agent_memory_episode_id, asset_id, etc. The reasoning_trace expands
  -- to show the agent's `think` tokens when the user clicks "why?".
  citations       jsonb not null default '[]'::jsonb,
  -- Optional rich extras — collapsed/null when not used.
  suggestions     jsonb,                     -- 1-3 action buttons beneath the message
  reasoning_trace jsonb,                     -- think tokens; expandable on demand
  confidence      numeric check (confidence is null or confidence between 0 and 1),
  acted_on        jsonb,                     -- audit trail when the agent took state-changing action(s)
  parent_id       uuid references public.agent_messages on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists agent_messages_thread_time
  on public.agent_messages (thread_id, created_at);

create index if not exists agent_messages_org_recent
  on public.agent_messages (org_id, created_at desc);

comment on table public.agent_messages is
  'Per-org chat message. org_id denormalised from agent_threads so '
  'realtime filtering needs no join. blocks is the typed AgentBlock[] '
  'schema from AISecurityEngineerUXRoadmap.md §11.';

alter table public.agent_messages enable row level security;

drop policy if exists agent_messages_org_read on public.agent_messages;
create policy agent_messages_org_read on public.agent_messages
  for select to authenticated
  using (org_id = public.current_org_id());

-- Authenticated users can post user-role messages; the worker (service
-- role) is the only writer for agent/system/tool roles.
drop policy if exists agent_messages_user_insert on public.agent_messages;
create policy agent_messages_user_insert on public.agent_messages
  for insert to authenticated
  with check (
    org_id = public.current_org_id()
    and role = 'user'
  );

-- ============== 3. KEEP org_id CONSISTENT WITH thread ==============
-- The frontend that posts a message only knows thread_id. The trigger
-- derives org_id from the thread so a misconfigured client can't put a
-- message under the wrong org. Also enforces the thread-org match: a
-- service-role write that supplies an org_id different from the thread's
-- gets rejected.

create or replace function public.agent_messages_set_org_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_org uuid;
begin
  select org_id into v_thread_org from public.agent_threads where id = new.thread_id;
  if v_thread_org is null then
    raise exception 'agent_messages: thread_id % not found', new.thread_id;
  end if;
  if new.org_id is null then
    new.org_id := v_thread_org;
  elsif new.org_id <> v_thread_org then
    raise exception 'agent_messages: org_id % does not match thread org %', new.org_id, v_thread_org;
  end if;
  return new;
end;
$$;

drop trigger if exists agent_messages_set_org_id_trg on public.agent_messages;
create trigger agent_messages_set_org_id_trg
  before insert on public.agent_messages
  for each row execute function public.agent_messages_set_org_id();

-- ============== 4. BUMP THREAD last_message_at ON NEW MESSAGE ==============

create or replace function public.agent_threads_bump_last_message_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agent_threads
     set last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), new.created_at)
   where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists agent_threads_bump_last_message_at_trg on public.agent_messages;
create trigger agent_threads_bump_last_message_at_trg
  after insert on public.agent_messages
  for each row execute function public.agent_threads_bump_last_message_at();

-- ============== 5. NOW agent_memory_episodes.thread_id CAN BE A REAL FK ==============
-- Adds the FK constraint deferred in migration 041. Existing episodes with
-- thread_id=NULL stay valid; only non-null thread_ids must reference a
-- real thread from here on.

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'agent_memory_episodes'
      and constraint_name = 'agent_memory_episodes_thread_id_fkey'
  ) then
    alter table public.agent_memory_episodes
      add constraint agent_memory_episodes_thread_id_fkey
      foreign key (thread_id) references public.agent_threads(id) on delete set null;
  end if;
end $$;

-- ============== 6. REALTIME ==============

alter publication supabase_realtime add table public.agent_messages;
alter publication supabase_realtime add table public.agent_threads;

-- ============== 7. SERVICE-ROLE HELPERS FOR THE WORKER ==============
-- The worker writes agent_messages with role in ('agent','system','tool')
-- as part of finding-driven chat narratives, daily digests, and tool-
-- execution narration. Going through an RPC (vs. raw insert) lets us
-- guard role validity + denormalise org_id from the thread + keep the
-- write surface auditable.

create or replace function public.worker_post_agent_message(
  p_thread_id   uuid,
  p_role        text,
  p_blocks      jsonb,
  p_citations   jsonb default '[]'::jsonb,
  p_suggestions jsonb default null,
  p_reasoning_trace jsonb default null,
  p_confidence  numeric default null,
  p_acted_on    jsonb default null,
  p_parent_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_post_agent_message requires service role';
  end if;

  if p_role not in ('agent','system','tool') then
    raise exception 'worker_post_agent_message: role must be one of agent/system/tool, got %', p_role;
  end if;

  insert into public.agent_messages (
    thread_id, role, blocks, citations,
    suggestions, reasoning_trace, confidence, acted_on, parent_id
  )
  values (
    p_thread_id, p_role, p_blocks, p_citations,
    p_suggestions, p_reasoning_trace, p_confidence, p_acted_on, p_parent_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.worker_post_agent_message(uuid, text, jsonb, jsonb, jsonb, jsonb, numeric, jsonb, uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_post_agent_message(uuid, text, jsonb, jsonb, jsonb, jsonb, numeric, jsonb, uuid)
  to service_role;

-- Ensure a single "primary" thread exists per org for the worker to post
-- finding-driven messages into without first choosing a thread. The
-- onboarding flow can also use this as the seed thread.
--
-- Idempotent: returns the existing primary thread or creates one.
create or replace function public.worker_get_or_create_primary_thread(
  p_org_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_get_or_create_primary_thread requires service role';
  end if;

  select id into v_id
    from public.agent_threads
   where org_id = p_org_id
     and (context->>'kind') = 'primary'
     and archived = false
   limit 1;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.agent_threads (org_id, title, context)
  values (
    p_org_id,
    'Strix',
    jsonb_build_object('kind', 'primary')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.worker_get_or_create_primary_thread(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_get_or_create_primary_thread(uuid)
  to service_role;
