-- Slack-bridge agent chat messages — AISecurityEngineerUXRoadmap.md §6
-- Phase D v1.
--
-- The org's Slack webhook (migration 037) already receives scan-
-- completion summaries via notifier.py. This migration extends the
-- bridge so agent-role messages posted into the org's chat surface
-- (finding-driven cards, dismiss confirmations, suppression notes,
-- daily digests) also land in the org's Slack channel — for orgs
-- that opt in.
--
-- Two pieces:
--
--   1. organizations.slack_bridge_enabled (default false) — explicit
--      opt-in. Even orgs with a configured Slack webhook don't get
--      their chat noise forwarded by default; the bridge is its own
--      decision.
--
--   2. A trigger on agent_messages that fires pg_notify when:
--        - row.role = 'agent'
--        - row.parent_id is null (so threaded refinements don't
--          flood the channel)
--        - row's org has slack_bridge_enabled = true
--      The worker's listener picks up 'agent_message_for_slack',
--      reads the message + webhook, posts to Slack. Worker-side
--      changes ship in a follow-up commit.

alter table public.organizations
  add column if not exists slack_bridge_enabled boolean not null default false;

comment on column public.organizations.slack_bridge_enabled is
  'Per-org opt-in for forwarding agent_messages (role=agent, '
  'parent_id=null) to the configured Slack webhook (migration 037). '
  'Default false — even orgs with a webhook don''t get chat noise '
  'forwarded without explicit opt-in.';

create or replace function public.notify_slack_for_agent_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
begin
  -- Only consider top-level agent messages. Refinements / system /
  -- user / tool roles stay in-app.
  if new.role <> 'agent' or new.parent_id is not null then
    return new;
  end if;

  -- Check the org's opt-in flag. Lookup is cheap (PK index on
  -- organizations); the trigger fires often but the early exit
  -- above eliminates most rows.
  select slack_bridge_enabled into v_enabled
    from public.organizations
   where id = new.org_id;

  if v_enabled is not true then
    return new;
  end if;

  -- Notify the worker. Payload is the message_id only; worker fetches
  -- the row + webhook via its service-role client. Keeping the payload
  -- small avoids the 8 KB pg_notify limit if a chat message has a
  -- huge blocks array.
  perform pg_notify('agent_message_for_slack', new.id::text);
  return new;
exception
  when others then
    raise notice 'notify_slack_for_agent_message failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists agent_messages_notify_slack on public.agent_messages;
create trigger agent_messages_notify_slack
  after insert on public.agent_messages
  for each row execute function public.notify_slack_for_agent_message();
