-- Stream findings into each org's chat — first concrete user-visible
-- payoff of the conversational shell (migration 042).
--
-- AISecurityEngineerUXRoadmap.md §3 (Phase A) commits to: "as the
-- engine emits finding.created, the agent posts a chat message in the
-- form 'I found X. it matters because Y. want me to do Z?'"
--
-- Two levels of fidelity:
--
--   1. (THIS MIGRATION) Structured-blocks message — text block with
--      severity + title + target, plus a finding_ref block so the
--      frontend can render an inline card with citations. No LLM
--      dependency, fires the moment a finding lands.
--
--   2. (FOLLOW-UP) LLM-narrated rephrasing — the worker's triage path
--      composes a richer narrative ("it matters because…", "want me to
--      do X?") and posts a parent_id-linked refinement. This works on
--      top of the structured message — the structured message lands
--      first so the realtime stream is immediate.
--
-- Implementation: an after-insert trigger on `public.findings` that
-- calls a SECURITY DEFINER helper. The trigger never raises (a chat-
-- post failure must not roll back the finding insert). Heartbeat
-- semantics same as worker_insert_finding's scan_event call.

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
  -- Only the canonical insert (not recurrence-update via worker_insert_finding)
  -- fires the chat post. Recurrence already flows via scan_events.
  -- Recurrences UPDATE; this is an AFTER INSERT trigger so we're good.

  -- Resolve or create the org's primary thread.
  select id into v_thread_id
    from public.agent_threads
   where org_id = new.org_id
     and (context->>'kind') = 'primary'
     and archived = false
   limit 1;

  if v_thread_id is null then
    insert into public.agent_threads (org_id, title, context)
    values (new.org_id, 'Strix', jsonb_build_object('kind','primary'))
    returning id into v_thread_id;
  end if;

  -- Resolve a friendly target label.
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

  -- Compose the message body: a text block with the headline, plus a
  -- finding_ref block the frontend renders as an inline card with PoC /
  -- evidence expansion. Citations point back at the finding for any
  -- "show me why" follow-up.
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
    -- Two action affordances per Phase A spec — "see fix" + "dismiss".
    -- These are intent labels the frontend renders as buttons; the
    -- chat-action handler that processes them lands in Phase B.
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
  -- Belt-and-braces: any failure here MUST NOT roll back the finding
  -- insert. Findings are the canonical record; the chat message is a
  -- derived courtesy. Log via raise notice (Supabase captures these to
  -- postgres logs) and continue.
  when others then
    raise notice 'post_finding_to_org_chat failed for finding %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists findings_post_to_chat on public.findings;
create trigger findings_post_to_chat
  after insert on public.findings
  for each row execute function public.post_finding_to_org_chat();
