-- Extend worker_insert_finding to plumb the engine's new structured fields
-- into the columns added by migration 024. All new keys are read from the
-- payload JSONB; absent keys land as null (existing wrapper-side ingest
-- continues working unchanged).
--
-- The full set of new payload keys read by this RPC:
--
--   payload.category                        → findings.category
--   payload.description_plain               → findings.description_plain
--   payload.recommended_action              → findings.recommended_action
--   payload.priority_label                  → findings.priority_label
--   payload.verification_status             → findings.verification_status
--   payload.confidence                      → findings.confidence (numeric)
--   payload.reproducibility_token           → findings.reproducibility_token
--   payload.fingerprint_version             → findings.fingerprint_version (int)
--   payload.is_canonical                    → findings.is_canonical (bool)
--   payload.reasoning_trace                 → findings.reasoning_trace (jsonb)
--   payload.counter_proof                   → findings.counter_proof (jsonb)
--   payload.kill_chain                      → findings.kill_chain (jsonb)
--   payload.compliance_controls             → findings.compliance_controls (jsonb)
--   payload.data_classification             → findings.data_classification
--   payload.mitre_attack                    → findings.mitre_attack (jsonb)
--   payload.owasp_top_10                    → findings.owasp_top_10
--   payload.owasp_api_top_10                → findings.owasp_api_top_10
--   payload.features                        → findings.features (jsonb)
--   payload.engine_auto_dismissed           → findings.engine_auto_dismissed (bool)
--   payload.engine_auto_dismissal_reason    → findings.engine_auto_dismissal_reason
--   payload.severity_pre_auto_dismissal     → findings.severity_pre_auto_dismissal
--   payload.prior_label_attribution         → findings.prior_label_attribution (jsonb)
--
-- The dedup-on-fingerprint and reopen-on-recurrence behaviours from
-- migration 017 are preserved verbatim — only the INSERT branch widens.

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
    -- Engine-signal columns (migration 024).
    category, description_plain, recommended_action,
    priority_label, verification_status, confidence,
    reproducibility_token, fingerprint_version, is_canonical,
    reasoning_trace, counter_proof, kill_chain,
    compliance_controls, data_classification,
    mitre_attack, owasp_top_10, owasp_api_top_10,
    features,
    engine_auto_dismissed, engine_auto_dismissal_reason,
    severity_pre_auto_dismissal, prior_label_attribution
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
    -- Engine-signal columns. Each is best-effort — null when the
    -- engine didn't supply, the wrapper's existing behaviour
    -- continues working.
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
    p_payload->'prior_label_attribution'
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
