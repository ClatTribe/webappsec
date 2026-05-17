-- Rebrand the agent persona from "Strix" to "TensorShield" everywhere the
-- name appears in seeded DB values + existing data.
--
-- Touches:
--   1. agent_memory_preferences.voice.name default — was 'Strix', now
--      'TensorShield'. Updates the seed trigger from migration 041 +
--      backfills every existing row.
--   2. agent_threads.title — finding-driven thread auto-created by the
--      worker_get_or_create_primary_thread RPC (migration 042) + the
--      findings_post_to_chat trigger (migration 043) was titled 'Strix'.
--      Both helpers + the existing rows get renamed.
--
-- Idempotent on re-run.

-- ============== 1. UPDATE SEED TRIGGER ==============

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
    jsonb_build_object(
      'default',          'ask_before_act',
      'auto_fix_severity', null,
      'auto_dismiss',     false,
      'slack_notify',     'always'
    ),
    jsonb_build_object(
      'tone',      'professional_friendly',
      'verbosity', 'mid',
      'name',      'TensorShield'
    ),
    jsonb_build_object(),
    jsonb_build_object(
      'daily_digest_time', '09:00Z',
      'digest_channels',   to_jsonb(array['in_app']::text[])
    )
  )
  on conflict (org_id) do nothing;
  return new;
end;
$$;

-- ============== 2. BACKFILL EXISTING PREFERENCES ==============
-- jsonb_set on the existing voice column. Idempotent.

update public.agent_memory_preferences
   set voice = jsonb_set(coalesce(voice, '{}'::jsonb), '{name}', '"TensorShield"'::jsonb)
 where coalesce(voice->>'name', '') = 'Strix';

-- ============== 3. UPDATE worker_get_or_create_primary_thread ==============
-- Match migration 042 except for the default title.

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
    'TensorShield',
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

-- ============== 4. UPDATE findings_post_to_chat TRIGGER ==============
-- Only the literal thread-title 'Strix' changes — the rest of the
-- trigger from migration 043 is preserved verbatim.

create or replace function public.post_finding_to_org_chat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id  uuid;
  v_target_val text;
  v_target_lbl text;
  v_severity_emoji text;
  v_text_md text;
begin
  select id into v_thread_id
    from public.agent_threads
   where org_id = new.org_id
     and (context->>'kind') = 'primary'
     and archived = false
   limit 1;

  if v_thread_id is null then
    insert into public.agent_threads (org_id, title, context)
    values (new.org_id, 'TensorShield', jsonb_build_object('kind','primary'))
    returning id into v_thread_id;
  end if;

  if new.target_id is not null then
    select coalesce(t.name, t.value) into v_target_lbl
      from public.targets t where t.id = new.target_id;
  end if;
  v_target_val := coalesce(new.target, new.endpoint, v_target_lbl, '');

  v_severity_emoji := case new.severity
    when 'critical' then '🛑'
    when 'high'     then '🔴'
    when 'medium'   then '🟠'
    when 'low'      then '🟡'
    else                 '🔵'
  end;

  v_text_md :=
    v_severity_emoji || '  **' || initcap(coalesce(new.severity, 'info')) || '** — '
    || coalesce(new.title, '(untitled finding)')
    || case when v_target_val <> '' then E'\n\nFound in `' || v_target_val || '`.' else '' end;

  insert into public.agent_messages (
    thread_id, role, blocks, citations, suggestions
  )
  values (
    v_thread_id,
    'agent',
    jsonb_build_array(
      jsonb_build_object('type', 'text', 'markdown', v_text_md),
      jsonb_build_object('type', 'finding_ref', 'finding_id', new.id::text)
    ),
    jsonb_build_array(
      jsonb_build_object(
        'kind', 'finding',
        'id', new.id::text,
        'label', coalesce(new.title, new.severity)
      ),
      case when new.scan_id is not null then
        jsonb_build_object('kind', 'scan', 'id', new.scan_id::text)
      else null end
    ) - 'null',
    case
      when new.severity in ('critical','high') then jsonb_build_array(
        jsonb_build_object('label', 'See details',  'action', 'open_finding', 'payload', jsonb_build_object('finding_id', new.id::text)),
        jsonb_build_object('label', 'Suggest fix',  'action', 'suggest_fix',  'payload', jsonb_build_object('finding_id', new.id::text)),
        jsonb_build_object('label', 'Dismiss',      'action', 'dismiss',      'payload', jsonb_build_object('finding_id', new.id::text))
      )
      else jsonb_build_array(
        jsonb_build_object('label', 'See details',  'action', 'open_finding', 'payload', jsonb_build_object('finding_id', new.id::text)),
        jsonb_build_object('label', 'Dismiss',      'action', 'dismiss',      'payload', jsonb_build_object('finding_id', new.id::text))
      )
    end
  );
  return new;
exception
  when others then
    raise notice 'post_finding_to_org_chat failed for finding %: %', new.id, sqlerrm;
    return new;
end;
$$;

-- ============== 5. BACKFILL EXISTING THREAD TITLES ==============

update public.agent_threads
   set title = 'TensorShield'
 where title = 'Strix';
