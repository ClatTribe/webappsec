-- Close the suppression loop — AISecurityEngineerUXRoadmap.md §4 Phase B.
--
-- Migration 044 materialises per-org suppression rules from dismissal
-- episodes. This migration makes those rules ACT: worker_insert_finding
-- now consults the rules before inserting and short-circuits if a rule
-- with sufficient confidence matches the incoming finding's fingerprint.
--
-- When a finding is suppressed:
--   1. The finding row is NOT inserted (the scan's findings count
--      reflects only un-suppressed findings).
--   2. A 'finding.suppressed' scan_event is emitted with the rule
--      reference so the trajectory is auditable.
--   3. A chat message is posted to the org's primary thread: "I would
--      have flagged X but your suppression rule from Y covers it."
--      This preserves the user's awareness that something was caught
--      and chose not to surface it — silence would be wrong.
--
-- Confidence threshold for suppression: 0.75. Per migration 044 that
-- means either two silent dismissals (0.7 + 0.05 = 0.75) or one
-- user-explained dismissal (told_by_user source bumps confidence into
-- this band). A single silent click does NOT suppress — too noisy.

create or replace function public.should_suppress_finding(
  p_org_id      uuid,
  p_fingerprint text
)
returns table (
  rule_id           uuid,
  fingerprint       text,
  dismissal_count   int,
  source            text,
  confidence        numeric,
  last_reason       text,
  first_dismissed_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    f.id                                   as rule_id,
    f.key                                  as fingerprint,
    (f.value->>'count')::int               as dismissal_count,
    f.source                               as source,
    f.confidence                           as confidence,
    f.value->>'last_reason'                as last_reason,
    (f.value->>'first_dismissed_at')::timestamptz as first_dismissed_at
  from public.agent_memory_facts f
  where f.org_id        = p_org_id
    and f.scope         = 'suppression'
    and f.key           = p_fingerprint
    and f.superseded_by is null
    and f.confidence    >= 0.75
  limit 1;
$$;

revoke execute on function public.should_suppress_finding(uuid, text)
  from public, anon, authenticated;
grant   execute on function public.should_suppress_finding(uuid, text)
  to service_role;

-- Rewrite worker_insert_finding to consult should_suppress before
-- inserting. Preserves all existing behaviour for non-suppressed findings;
-- adds a short-circuit path for matches.

create or replace function public.worker_insert_finding(
  p_scan_id  uuid,
  p_vuln_id  text,
  p_title    text,
  p_severity text,
  p_payload  jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id     uuid;
  v_target_id  uuid;
  v_id         uuid;
  v_fp         text;
  v_existing_id      uuid;
  v_existing_status  text;
  v_supp_row   record;
  v_thread_id  uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_insert_finding requires service role';
  end if;

  select org_id, target_id into v_org_id, v_target_id
  from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  v_fp := nullif(p_payload->>'fingerprint', '');

  -- ---------- SUPPRESSION GATE ----------
  -- Consult the org's learned rules. Only short-circuit if a rule
  -- exists with confidence >= 0.75 (see migration 044 + this migration's
  -- threshold rationale above).
  if v_fp is not null then
    select * into v_supp_row
      from public.should_suppress_finding(v_org_id, v_fp);

    if v_supp_row.rule_id is not null then
      -- Emit a scan_event so the trajectory and the auditor pack reflect
      -- that the engine produced this finding but the wrapper suppressed it.
      perform public.worker_insert_scan_event(
        p_scan_id, 'finding.suppressed',
        jsonb_build_object(
          'vuln_id',         p_vuln_id,
          'title',           p_title,
          'severity',        p_severity,
          'fingerprint',     v_fp,
          'rule_id',         v_supp_row.rule_id,
          'dismissal_count', v_supp_row.dismissal_count,
          'source',          v_supp_row.source,
          'confidence',      v_supp_row.confidence,
          'last_reason',     v_supp_row.last_reason
        )
      );

      -- Post a chat note to the org's primary thread so the user knows
      -- the platform caught something but chose not to surface it. Use
      -- the worker_get_or_create_primary_thread helper from migration 042.
      v_thread_id := public.worker_get_or_create_primary_thread(v_org_id);
      perform public.worker_post_agent_message(
        v_thread_id,
        'agent',
        jsonb_build_array(
          jsonb_build_object(
            'type', 'text',
            'markdown',
            format(
              '🤐 Suppressed: **%s** — your rule from %s ago covers this (dismissed %s times before%s).%s',
              coalesce(p_title, '(untitled)'),
              case
                when v_supp_row.first_dismissed_at is not null then
                  age(now(), v_supp_row.first_dismissed_at)::text
                else 'a while'
              end,
              v_supp_row.dismissal_count,
              case when v_supp_row.source = 'told_by_user' then ', with your reason on file' else '' end,
              case when v_supp_row.last_reason is not null
                   then E'\n\n> ' || v_supp_row.last_reason
                   else ''
              end
            )
          )
        ),
        jsonb_build_array(
          jsonb_build_object('kind','scan','id', p_scan_id::text)
        )
      );

      -- Return null — no finding row was created. Worker callers check
      -- the return value and treat null as "no canonical finding to
      -- attach further metadata to".
      return null;
    end if;
  end if;

  -- ---------- EXISTING DEDUP + INSERT PATH (unchanged from migration 011) ----------
  if v_fp is not null then
    select id, status into v_existing_id, v_existing_status
    from public.findings
    where org_id = v_org_id and fingerprint = v_fp
    limit 1;

    if v_existing_id is not null then
      update public.findings
      set times_seen        = times_seen + 1,
          last_seen_at      = now(),
          last_seen_scan_id = p_scan_id,
          target_id         = coalesce(target_id, v_target_id)
      where id = v_existing_id;

      if v_existing_status in ('open', 'triaged_real') then
        perform public.worker_insert_scan_event(
          p_scan_id, 'finding.recurred',
          jsonb_build_object(
            'finding_id', v_existing_id,
            'vuln_id',    p_vuln_id,
            'title',      p_title,
            'severity',   p_severity,
            'status',     v_existing_status
          )
        );
      end if;

      return v_existing_id;
    end if;
  end if;

  insert into public.findings (
    scan_id, org_id, target_id, vuln_id, title, severity,
    cvss, cvss_vector, cwe, cve, target, endpoint, method,
    description_md, technical_analysis_md, poc_md, impact_md, remediation_md,
    affected_files, fingerprint,
    last_seen_scan_id
  )
  values (
    p_scan_id, v_org_id, v_target_id, p_vuln_id, p_title, p_severity,
    (p_payload->>'cvss')::numeric,
    p_payload->>'cvss_vector',
    p_payload->>'cwe',
    p_payload->>'cve',
    p_payload->>'target',
    p_payload->>'endpoint',
    p_payload->>'method',
    p_payload->>'description_md',
    p_payload->>'technical_analysis_md',
    p_payload->>'poc_md',
    p_payload->>'impact_md',
    p_payload->>'remediation_md',
    p_payload->'affected_files',
    v_fp,
    p_scan_id
  )
  returning id into v_id;

  perform public.worker_insert_scan_event(
    p_scan_id, 'finding.created',
    jsonb_build_object(
      'finding_id', v_id,
      'vuln_id',    p_vuln_id,
      'title',      p_title,
      'severity',   p_severity
    )
  );

  return v_id;
end;
$$;

revoke execute on function public.worker_insert_finding(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant   execute on function public.worker_insert_finding(uuid, text, text, text, jsonb)
  to service_role;
