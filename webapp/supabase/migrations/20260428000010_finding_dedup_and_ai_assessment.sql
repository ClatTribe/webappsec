-- Fingerprint-based dedup + LLM-driven assessment columns.
--
-- Background. The original schema (init_schema.sql) had a `fingerprint` column
-- and an index on `(org_id, fingerprint)` but nothing populated it, so every
-- scan re-created the same findings as new rows. Combined with no AI triage,
-- users hit alert fatigue immediately. This migration adds the supporting
-- state and rewires worker_insert_finding to dedup against it.

alter table public.findings
  add column if not exists times_seen        int         not null default 1,
  add column if not exists last_seen_at      timestamptz not null default now(),
  add column if not exists last_seen_scan_id uuid        references public.scans(id),
  add column if not exists ai_assessment     jsonb,
  add column if not exists ai_assessed_at    timestamptz;

create index if not exists findings_org_urgency
  on public.findings (org_id, ((ai_assessment->>'urgency')));

-- ============== INSERT FINDING (dedup-aware) ==============
--
-- Behaviour:
--   1. If a finding with the same (org_id, fingerprint) already exists:
--        - update times_seen, last_seen_at, last_seen_scan_id
--        - emit finding.recurred event (only if the existing one was unresolved)
--        - return existing id; do NOT create a duplicate row
--   2. If no existing finding:
--        - insert as before, emit finding.created, return new id
--
-- Findings without a fingerprint always insert (legacy behaviour, kept for safety).
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
      update public.findings
      set times_seen        = times_seen + 1,
          last_seen_at      = now(),
          last_seen_scan_id = p_scan_id
      where id = v_existing_id;

      -- Only surface to the live event stream if the user still cares about it.
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
    scan_id, org_id, vuln_id, title, severity,
    cvss, cvss_vector, cwe, cve, target, endpoint, method,
    description_md, technical_analysis_md, poc_md, impact_md, remediation_md,
    affected_files, fingerprint,
    last_seen_scan_id
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
