-- §15.1 Tier 2 — per-finding reasoning trail viewer (engine PR #142).
--
-- Engine writes <run_dir>/trajectory.jsonl at run end with one record per
-- finding: events_compact[], iterations_to_emit, time_to_emit_seconds,
-- dismissed_alternatives[], exploration_breadth. The wrapper's worker
-- joins trajectory records to findings by finding_id and persists the
-- whole record as JSONB so the UI can render the "How did the engine
-- arrive at this?" panel without an extra round-trip.
--
-- We add it as a single nullable column rather than a sidecar table
-- because (a) trajectories are 1:1 with findings, (b) we never query by
-- internal trajectory shape, and (c) the engine schema-versions the
-- record itself so additive changes don't require a migration here.
--
-- Per Architecture.md §1.1: the engine is the source of truth for
-- reasoning trails — wrapper persists the structured record verbatim.

alter table public.findings
  add column if not exists trajectory jsonb;

-- Lightweight functional index for "engine struggled" filtering on the
-- run-summary dashboard ("find scans where any finding's iterations
-- exceeded N"). Cast safely — engine writes integers, but a future
-- schema drift to a numeric or string shouldn't break the index.
create index if not exists findings_trajectory_iterations_idx
  on public.findings (((trajectory->>'iterations_to_emit')))
  where trajectory is not null;

-- ============== Plumb payload.trajectory through worker_insert_finding ==============
--
-- Same pattern as migration 025: extend the INSERT branch to read one new
-- payload key. Recurrence path is intentionally untouched — the original
-- scan's trajectory is the canonical reasoning trail; subsequent scans'
-- trajectories would shadow it without adding new operator value.

create or replace function public.worker_insert_finding(
  p_scan_id uuid,
  p_vuln_id text,
  p_title text,
  p_severity text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_id uuid;
  v_fp text;
  v_existing_id uuid;
  v_existing_status text;
  v_reopened boolean := false;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_insert_finding requires service role';
  end if;

  select org_id into v_org_id from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  v_fp := nullif(p_payload->>'fingerprint', '');

  if v_fp is not null then
    select id, status into v_existing_id, v_existing_status
      from public.findings
     where org_id = v_org_id and fingerprint = v_fp
     limit 1;

    if v_existing_id is not null then
      if v_existing_status = 'fixed' then
        update public.findings
           set status            = 'triaged_real',
               triaged_by        = null,
               triaged_at        = now(),
               times_seen        = times_seen + 1,
               last_seen_at      = now(),
               last_seen_scan_id = p_scan_id,
               reopened_count    = reopened_count + 1
         where id = v_existing_id;
        v_reopened := true;

        perform public.worker_insert_scan_event(
          p_scan_id, 'finding.reopened',
          jsonb_build_object(
            'finding_id', v_existing_id,
            'vuln_id',    p_vuln_id,
            'title',      p_title,
            'severity',   p_severity
          )
        );
      else
        update public.findings
           set times_seen        = times_seen + 1,
               last_seen_at      = now(),
               last_seen_scan_id = p_scan_id
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
      end if;

      insert into public.finding_occurrences (finding_id, scan_id, org_id, reopened)
      values (v_existing_id, p_scan_id, v_org_id, v_reopened)
      on conflict (finding_id, scan_id) do nothing;

      return v_existing_id;
    end if;
  end if;

  insert into public.findings (
    scan_id, org_id, vuln_id, title, severity,
    cvss, cvss_vector, cwe, cve, target, endpoint, method,
    description_md, technical_analysis_md, poc_md, impact_md, remediation_md,
    affected_files, fingerprint,
    last_seen_scan_id,
    category, description_plain, recommended_action,
    priority_label, verification_status, confidence,
    reproducibility_token, fingerprint_version, is_canonical,
    reasoning_trace, counter_proof, kill_chain,
    compliance_controls, data_classification,
    mitre_attack, owasp_top_10, owasp_api_top_10,
    features,
    engine_auto_dismissed, engine_auto_dismissal_reason,
    severity_pre_auto_dismissal, prior_label_attribution,
    -- Migration 029.
    trajectory
  )
  values (
    p_scan_id, v_org_id, p_vuln_id, p_title, p_severity,
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
    p_scan_id,
    p_payload->>'category',
    p_payload->>'description_plain',
    p_payload->>'recommended_action',
    p_payload->>'priority_label',
    p_payload->>'verification_status',
    nullif(p_payload->>'confidence', '')::numeric,
    p_payload->>'reproducibility_token',
    nullif(p_payload->>'fingerprint_version', '')::int,
    coalesce((p_payload->>'is_canonical')::boolean, true),
    p_payload->'reasoning_trace',
    p_payload->'counter_proof',
    p_payload->'kill_chain',
    p_payload->'compliance_controls',
    p_payload->>'data_classification',
    p_payload->'mitre_attack',
    p_payload->>'owasp_top_10',
    p_payload->>'owasp_api_top_10',
    p_payload->'features',
    coalesce((p_payload->>'engine_auto_dismissed')::boolean, false),
    p_payload->>'engine_auto_dismissal_reason',
    p_payload->>'severity_pre_auto_dismissal',
    p_payload->'prior_label_attribution',
    p_payload->'trajectory'
  )
  returning id into v_id;

  insert into public.finding_occurrences (finding_id, scan_id, org_id)
  values (v_id, p_scan_id, v_org_id)
  on conflict (finding_id, scan_id) do nothing;

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

-- ============== Preflight failure marker RPC ==============
--
-- Engine PR #30 — preflight defaults ON. Targets that fail preflight
-- exit 1 in ~5s with a diagnostic panel on stderr. The wrapper's worker
-- now captures stderr-tail and sets preflight_failed via this RPC after
-- pattern-matching the diagnostic markers. SECURITY DEFINER keeps the
-- worker scoped to its own scan rows.

create or replace function public.worker_set_preflight_failed(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_set_preflight_failed requires service role';
  end if;
  update public.scans set preflight_failed = true where id = p_scan_id;
end;
$$;

revoke execute on function public.worker_set_preflight_failed(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_set_preflight_failed(uuid)
  to service_role;
