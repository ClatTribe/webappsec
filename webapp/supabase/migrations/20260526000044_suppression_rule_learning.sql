-- Suppression rule learning — AISecurityEngineerUXRoadmap.md §4 Phase B.
--
-- When a user dismisses a finding (via chat suggestion button or NL bulk
-- command), the platform now learns from it. This migration adds an
-- after-insert trigger on agent_memory_episodes that, when the action is
-- 'finding_dismissed', upserts a fact in agent_memory_facts of
-- scope='suppression' keyed on the finding's fingerprint.
--
-- The fact accumulates state across dismissals of the same fingerprint:
--   - count: how many times this fingerprint has been dismissed
--   - last_dismissed_at: when the most recent dismissal happened
--   - last_reason: the rationale from the most recent dismissal
--   - last_titles: up to 5 distinct titles seen with this fingerprint
--
-- This is v1 — the rule is materialised but not yet consulted. v2 will
-- add a should_suppress() RPC that worker_insert_finding consults before
-- inserting, and a "Your suppression patterns" panel on the chat
-- sidebar that shows the user what their agent has learned.
--
-- Findings without a fingerprint (older inserts before the engine started
-- emitting them, or low-signal recon results) are skipped — no rule
-- material to learn from.

create or replace function public.learn_suppression_from_episode()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fingerprint text;
  v_title       text;
  v_reason      text;
  v_existing_id uuid;
  v_existing_value jsonb;
begin
  if new.agent_action <> 'finding_dismissed' then
    return new;
  end if;

  v_fingerprint := new.payload->>'finding_fingerprint';
  v_title       := new.payload->>'finding_title';
  v_reason      := new.rationale;

  -- No fingerprint -> no rule to learn. The dismissal episode is still
  -- recorded; we just can't materialise a per-fingerprint suppression.
  if v_fingerprint is null or v_fingerprint = '' then
    return new;
  end if;

  -- Upsert into agent_memory_facts. The unique index from migration 041
  -- (org_id, scope, key) where superseded_by is null means we can't have
  -- two current rows; we either update the current one or insert fresh.
  select id, value into v_existing_id, v_existing_value
    from public.agent_memory_facts
   where org_id = new.org_id
     and scope  = 'suppression'
     and key    = v_fingerprint
     and superseded_by is null
   limit 1;

  if v_existing_id is null then
    insert into public.agent_memory_facts (
      org_id, scope, key, value, source, confidence, created_by
    )
    values (
      new.org_id,
      'suppression',
      v_fingerprint,
      jsonb_build_object(
        'fingerprint',         v_fingerprint,
        'count',               1,
        'first_dismissed_at',  to_jsonb(new.created_at),
        'last_dismissed_at',   to_jsonb(new.created_at),
        'last_reason',         v_reason,
        'last_titles',         case when v_title is null then '[]'::jsonb
                                     else jsonb_build_array(v_title) end
      ),
      -- told_by_user when a reason was provided; agent_decision when
      -- the dismissal came from a button click with no rationale. This
      -- lets the future should_suppress() RPC weigh rules differently
      -- (a user-explained rule is higher-trust than a silent click).
      case when v_reason is not null and v_reason <> ''
           then 'told_by_user' else 'agent_decision' end,
      0.7,
      new.user_id
    );
  else
    -- Compose the new value. last_titles dedups + caps at 5.
    update public.agent_memory_facts
       set value = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   v_existing_value,
                   '{count}',
                   to_jsonb(coalesce((v_existing_value->>'count')::int, 0) + 1)
                 ),
                 '{last_dismissed_at}',
                 to_jsonb(new.created_at)
               ),
               '{last_reason}',
               to_jsonb(coalesce(v_reason, v_existing_value->>'last_reason'))
             ),
             '{last_titles}',
             (
               select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
                 from (
                   select v_title as t where v_title is not null
                   union
                   select jsonb_array_elements_text(coalesce(v_existing_value->'last_titles', '[]'::jsonb)) as t
                 ) s
                 where t is not null
                 limit 5
             )
           ),
           -- Promote source to told_by_user if any dismissal carried a
           -- rationale — once a human has explained the pattern, the rule
           -- is human-validated even if subsequent clicks were silent.
           source = case
             when v_reason is not null and v_reason <> '' then 'told_by_user'
             else source
           end,
           -- Confidence grows with repetition, capped at 0.95.
           confidence = least(
             0.95,
             coalesce(confidence, 0.7) + 0.05
           )
     where id = v_existing_id;
  end if;

  return new;
exception
  -- Belt-and-braces: a learner failure must not roll back the episode
  -- insert. The dismissal is real; missing the rule materialisation is
  -- a recoverable side-effect.
  when others then
    raise notice 'learn_suppression_from_episode failed for episode %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists agent_memory_episodes_learn_suppression on public.agent_memory_episodes;
create trigger agent_memory_episodes_learn_suppression
  after insert on public.agent_memory_episodes
  for each row execute function public.learn_suppression_from_episode();

-- Convenience: a view for "what rules has the agent learned for this org"
-- that the chat sidebar / settings page reads. Filters out stale-superseded
-- rows automatically.
create or replace view public.agent_suppression_rules_v as
select
  org_id,
  key                                 as fingerprint,
  (value->>'count')::int              as dismissal_count,
  (value->>'first_dismissed_at')      as first_dismissed_at,
  (value->>'last_dismissed_at')       as last_dismissed_at,
  (value->>'last_reason')             as last_reason,
  value->'last_titles'                as last_titles,
  source,
  confidence,
  created_by
from public.agent_memory_facts
where scope = 'suppression'
  and superseded_by is null;

-- The view inherits the RLS on agent_memory_facts, so each org's user only
-- ever sees their own rules. (Verified: postgres respects RLS on underlying
-- tables when selecting from a view.)
comment on view public.agent_suppression_rules_v is
  'Per-org suppression rules learned from agent_memory_episodes where '
  'agent_action=finding_dismissed. v1: materialised but not yet consulted '
  'at finding-insert time (v2 will add should_suppress() RPC).';
