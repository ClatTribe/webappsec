-- Auditor portal v2 — extended share-link payload + JSON export.
--
-- The base `get_audit_share_payload` (migration 054) returns the org's
-- per-control verdicts + a finding list. That's the auditor's
-- 30-second view. For their actual 30-minute review they want:
--
--   1. Cross-framework mapping awareness — "this single observation
--      credits 5 frameworks" should be obvious from the data, not
--      reconstructed by hand. We attach control_mappings to the
--      payload so the UI can collapse equivalent rows.
--
--   2. Evidence freshness — observed_at + each row's detail.expires_at
--      already exist; surface them in a normalised top-level shape so
--      the UI doesn't have to dig.
--
--   3. Audit-readiness score history — migration 070's
--      compliance_snapshots gives "Q1: 68 → Q2: 81" as a defensible
--      improvement narrative. Auditors love directional evidence.
--
--   4. Recent-activity timeline — a curated last-30-day slice of
--      audit_log (scan completions, collector runs, finding triage)
--      so the auditor can see *how* the org operates, not just
--      end-state verdicts. Limited to actions they should see; secret
--      decryption / vault access / RPC-internals are filtered out.
--
-- This migration:
--   - Replaces get_audit_share_payload with a v2 that returns the
--     expanded payload. Anon-callable; same security model.
--   - Adds a `version` field to the payload (the UI uses this to
--     gracefully fall back when an older deployment hasn't migrated).
--   - Does NOT touch audit_share_links itself — same token, same
--     RLS, same record_audit_share_access. Drop-in upgrade.

create or replace function public.get_audit_share_payload(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_link        record;
  v_org         record;
  v_posture     jsonb;
  v_findings    jsonb;
  v_stats       jsonb;
  v_mappings    jsonb;
  v_snapshots   jsonb;
  v_activity    jsonb;
begin
  -- Resolve the token. Must exist, not be revoked, not expired.
  select id, org_id, label, expires_at, revoked_at, access_count, last_accessed_at
    into v_link
  from public.audit_share_links
  where token = p_token
    and revoked_at is null
    and expires_at > now()
  limit 1;

  if v_link.id is null then
    return null;
  end if;

  -- Org metadata.
  select id, name, slug, created_at
    into v_org
  from public.organizations
  where id = v_link.org_id;

  -- Compliance posture — full per-control verdicts.
  select jsonb_agg(
    jsonb_build_object(
      'framework',     framework,
      'control_id',    control_id,
      'verdict',       verdict,
      'summary',       evidence_summary,
      'observed_at',   observed_at,
      'detail',        detail
    )
    order by framework, control_id
  )
  into v_posture
  from public.org_compliance_posture_v
  where org_id = v_link.org_id;

  -- Recent findings (last 90 days, top 50). Same projection as v1.
  select jsonb_agg(
    jsonb_build_object(
      'id',         id,
      'title',      title,
      'severity',   severity,
      'status',     status,
      'created_at', created_at,
      'triaged_at', triaged_at
    )
    order by created_at desc
  )
  into v_findings
  from (
    select id, title, severity, status, created_at, triaged_at
    from public.findings
    where org_id = v_link.org_id
      and created_at >= now() - interval '90 days'
    order by created_at desc
    limit 50
  ) f;

  -- Headline stats — same as v1, with one added: how many controls
  -- are stale (observed_at older than 90 days). That's a single
  -- field the audit page renders as a chip.
  select jsonb_build_object(
    'open_critical',     (select count(*) from public.findings
                            where org_id = v_link.org_id
                              and status = 'open'
                              and severity = 'critical'),
    'open_high',         (select count(*) from public.findings
                            where org_id = v_link.org_id
                              and status = 'open'
                              and severity = 'high'),
    'total_findings',    (select count(*) from public.findings   where org_id = v_link.org_id),
    'total_scans',       (select count(*) from public.scans      where org_id = v_link.org_id),
    'stale_controls',    (select count(*)
                            from public.org_compliance_posture_v
                           where org_id = v_link.org_id
                             and observed_at < now() - interval '90 days'),
    'monitoring_since',  v_org.created_at
  )
  into v_stats;

  -- Control mappings — static cross-framework equivalences. The UI
  -- uses this to collapse "this single mfa_enforcement observation
  -- credits 5 frameworks" into one row. Migration 071 owns the table;
  -- we project only the columns the page needs.
  select jsonb_agg(
    jsonb_build_object(
      'group_key',     group_key,
      'group_name',    group_name,
      'framework',     framework,
      'control_id',    control_id,
      'control_label', control_label
    )
    order by group_key, framework, control_id
  )
  into v_mappings
  from public.control_mappings;

  -- Audit-readiness snapshots — quarterly trend (migration 070). Pull
  -- last 8 quarters across all frameworks. Engine PR #258 gives us a
  -- 2-year window; auditors typically want at least 1 year.
  select jsonb_agg(
    jsonb_build_object(
      'framework',  framework,
      'quarter',    quarter,
      'score',      score,
      'breakdown',  breakdown,
      'snapshot_at', snapshot_at
    )
    order by framework, quarter desc
  )
  into v_snapshots
  from (
    select *
    from public.compliance_snapshots
    where org_id = v_link.org_id
    order by quarter desc, framework
    limit 32   -- 8 quarters × 4 frameworks
  ) s;

  -- Recent activity — last 30 days of audit_log, filtered to actions
  -- an auditor should see. We intentionally exclude vault-decryption,
  -- internal RPC bookkeeping, and anything that mentions secrets.
  -- The "interesting" set is scans, collector runs, finding triage,
  -- audit-share opens (so they can see prior accesses), and questionnaire
  -- activity.
  select jsonb_agg(
    jsonb_build_object(
      'action',        action,
      'resource_type', resource_type,
      'resource_id',   resource_id,
      'metadata',      metadata,
      'created_at',    created_at
    )
    order by created_at desc
  )
  into v_activity
  from (
    select action, resource_type, resource_id, metadata, created_at
    from public.audit_log
    where org_id = v_link.org_id
      and created_at >= now() - interval '30 days'
      and (
        action like 'scan.%'
        or action like 'finding.%'
        or action like 'evidence_collector.%'
        or action like 'audit_share_link.%'
        or action like 'questionnaire.%'
        or action like 'custom_rule.%'
        or action like 'compliance.%'
      )
    order by created_at desc
    limit 100
  ) a;

  return jsonb_build_object(
    'version', 2,
    'org', jsonb_build_object(
      'name', v_org.name,
      'slug', v_org.slug
    ),
    'link', jsonb_build_object(
      'label',           v_link.label,
      'expires_at',      v_link.expires_at,
      'access_count',    v_link.access_count
    ),
    'compliance',         coalesce(v_posture,   '[]'::jsonb),
    'findings',           coalesce(v_findings,  '[]'::jsonb),
    'stats',              v_stats,
    'control_mappings',   coalesce(v_mappings,  '[]'::jsonb),
    'readiness_history',  coalesce(v_snapshots, '[]'::jsonb),
    'recent_activity',    coalesce(v_activity,  '[]'::jsonb),
    'generated_at',       now()
  );
end;
$$;

revoke execute on function public.get_audit_share_payload(text) from public;
grant   execute on function public.get_audit_share_payload(text)
  to anon, authenticated, service_role;

comment on function public.get_audit_share_payload(text) is
  'Auditor portal v2 payload (migration 076). Adds control_mappings, '
  'readiness_history, and recent_activity to the v1 shape. Anon-callable; '
  'token is the access control. UI reads `version` to gracefully fall '
  'back when deployed against an older RPC.';
