-- Security-definer RPCs the worker calls to write events, finalize scans, and persist findings.
-- All require the service role; all enforce org consistency before mutating.

-- ============== INSERT EVENT ==============
create or replace function public.worker_insert_scan_event(
  p_scan_id uuid,
  p_event_type text,
  p_payload jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_insert_scan_event requires service role';
  end if;

  select org_id into v_org_id from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  insert into public.scan_events (scan_id, org_id, event_type, payload)
  values (p_scan_id, v_org_id, p_event_type, p_payload);
end;
$$;

revoke execute on function public.worker_insert_scan_event(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.worker_insert_scan_event(uuid, text, jsonb) to service_role;

-- ============== START SCAN ==============
create or replace function public.worker_start_scan(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_start_scan requires service role';
  end if;

  update public.scans
  set status = 'running',
      started_at = now()
  where id = p_scan_id and status = 'queued';

  perform public.worker_insert_scan_event(p_scan_id, 'scan.started', null);
end;
$$;

grant execute on function public.worker_start_scan(uuid) to service_role;

-- ============== FINISH SCAN ==============
create or replace function public.worker_finish_scan(
  p_scan_id uuid,
  p_status text,
  p_exit_code int default null,
  p_error_message text default null,
  p_total_input_tokens bigint default 0,
  p_total_output_tokens bigint default 0,
  p_total_cost numeric default 0,
  p_agents_count int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_finish_scan requires service role';
  end if;

  if p_status not in ('completed','failed','cancelled') then
    raise exception 'invalid finish status: %', p_status;
  end if;

  update public.scans
  set status = p_status,
      finished_at = now(),
      exit_code = p_exit_code,
      error_message = p_error_message,
      total_input_tokens = p_total_input_tokens,
      total_output_tokens = p_total_output_tokens,
      total_cost = p_total_cost,
      agents_count = p_agents_count
  where id = p_scan_id;

  perform public.worker_insert_scan_event(
    p_scan_id, 'scan.finished',
    jsonb_build_object('status', p_status, 'exit_code', p_exit_code)
  );
end;
$$;

grant execute on function public.worker_finish_scan(uuid, text, int, text, bigint, bigint, numeric, int) to service_role;

-- ============== INSERT FINDING ==============
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
begin
  if auth.role() not in ('service_role') then
    raise exception 'worker_insert_finding requires service role';
  end if;

  select org_id into v_org_id from public.scans where id = p_scan_id;
  if v_org_id is null then
    raise exception 'scan not found: %', p_scan_id;
  end if;

  insert into public.findings (
    scan_id, org_id, vuln_id, title, severity,
    cvss, cvss_vector, cwe, cve, target, endpoint, method,
    description_md, technical_analysis_md, poc_md, impact_md, remediation_md,
    affected_files, fingerprint
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
    p_payload->>'fingerprint'
  )
  returning id into v_id;

  -- Surface to the live event stream too.
  perform public.worker_insert_scan_event(
    p_scan_id, 'finding.created',
    jsonb_build_object('finding_id', v_id, 'vuln_id', p_vuln_id, 'title', p_title, 'severity', p_severity)
  );

  return v_id;
end;
$$;

grant execute on function public.worker_insert_finding(uuid, text, text, text, jsonb) to service_role;
