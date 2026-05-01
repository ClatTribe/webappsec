-- Pillar 1 item 2 — multi-step kill-chain narrative.
--
-- Returns a chronological list of the agent steps (tool calls + chat
-- reasoning) that immediately preceded a finding's creation, so the UI
-- can render *"leaked credential → re-used to log in → escalated to
-- admin"* style timelines on the FindingCard.
--
-- Why a heuristic and not deterministic attribution:
--
--   Strix's `finding.created` event in `events.jsonl` carries
--   `actor.agent_id`, but the `tools-wishlist.md` P4 ask
--   ("Agent / target context on every tool.execution event") hasn't
--   landed yet — so for some events, the agent_id is missing or in a
--   different position in the payload. We use a simple time-window
--   heuristic that's robust to those payload-shape differences:
--
--     1. Take the timestamp of the finding's `finding.created` event.
--     2. Pull `tool.execution.started` + `chat.message` events from
--        the same scan in the 5 minutes before that timestamp.
--     3. Cap at 15 steps so the UI stays scannable.
--     4. When `actor.agent_id` is present on the finding event AND on
--        candidate events, prefer same-agent matches; otherwise return
--        all matches in the time window.
--
-- The UI labels this as "approximate timeline" so users know it's not
-- a deterministic kill-chain reconstruction. When the upstream P4 ask
-- lands we promote to deterministic without changing the API surface.

create or replace function public.kill_chain_for_finding(p_finding_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_scan_id        uuid;
  v_finding_at     timestamptz;
  v_agent_id       text;
  v_steps          jsonb;
begin
  -- Resolve the finding's scan + the moment our worker recorded it.
  -- RLS on findings naturally limits cross-org access — if the caller
  -- can't see the finding, this returns NULL and bails.
  select f.scan_id, f.created_at into v_scan_id, v_finding_at
    from public.findings f where f.id = p_finding_id;
  if v_scan_id is null then
    return null;
  end if;

  -- Best-effort agent_id from the Strix-emitted finding.created event
  -- in scan_events (different from our worker_insert_finding's event,
  -- which carries the finding_id but no actor). Strix's payload nests
  -- actor in the outer `payload->actor` shape; we fall back across two
  -- common payload positions.
  select coalesce(
           se.payload->'actor'->>'agent_id',
           se.payload->'payload'->'actor'->>'agent_id'
         )
  into v_agent_id
    from public.scan_events se
   where se.scan_id = v_scan_id
     and se.event_type = 'finding.created'
     and se.created_at <= v_finding_at + interval '30 seconds'
     and se.created_at >= v_finding_at - interval '30 seconds'
   order by se.created_at desc
   limit 1;

  -- Pull the candidate steps. We take everything in the time window;
  -- the agent-id filter (when known) is applied as a secondary
  -- preference: if all 15 steps in the window are same-agent, great;
  -- if some aren't, we still surface the timeframe context.
  with steps as (
    select
      se.created_at,
      se.event_type,
      coalesce(
        se.payload->'actor'->>'agent_id',
        se.payload->'payload'->'actor'->>'agent_id'
      ) as event_agent_id,
      se.payload
    from public.scan_events se
    where se.scan_id = v_scan_id
      and se.event_type in ('tool.execution.started', 'chat.message')
      and se.created_at < v_finding_at
      and se.created_at >= v_finding_at - interval '5 minutes'
  ),
  filtered as (
    -- When v_agent_id is null, keep everything in the window.
    -- When set, prefer same-agent matches, but fall back to the full
    -- window if filtering produces zero rows (catches the case where
    -- agent_id is on finding.created but absent from earlier events).
    (
      select * from steps
       where v_agent_id is not null and event_agent_id = v_agent_id
       order by created_at desc
       limit 15
    )
    union all
    (
      select * from steps
       where v_agent_id is null
          or not exists (
            select 1 from steps s2
             where v_agent_id is not null and s2.event_agent_id = v_agent_id
          )
       order by created_at desc
       limit 15
    )
  )
  select jsonb_build_object(
    'agent_id', v_agent_id,
    'finding_at', v_finding_at,
    'steps', coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'created_at', f.created_at,
          'event_type', f.event_type,
          'payload',    f.payload
        ) order by f.created_at asc)
        from filtered f
      ),
      '[]'::jsonb
    )
  ) into v_steps;

  return v_steps;
end;
$$;

grant execute on function public.kill_chain_for_finding(uuid) to authenticated;
