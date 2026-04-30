-- Cross-scan finding deduplication, part 2: occurrence ledger + reopen on
-- recurrence + first-seen bookend.
--
-- Migration 010 shipped the dedup *mechanism* — fingerprint hash, times_seen
-- counter, last_seen_at / last_seen_scan_id pointers. What was missing:
--
--   1. Lineage. `times_seen` is a count, but you can't enumerate which scans
--      saw the finding. The new finding_occurrences table is the source of
--      truth for cross-scan history; finding-level columns (times_seen /
--      first_seen_at / last_seen_at) are denormalised conveniences for the
--      hot path.
--
--   2. A first_seen_at bookend. We had last_seen_at but no first. Without
--      both, the UI can't show the lifespan of a finding.
--
--   3. Reopen-on-recurrence. If a user marked a finding 'fixed' and the
--      scanner detects it again, that's a regression — the fix didn't take.
--      Previously we silently bumped times_seen and left status='fixed',
--      which silently masked a real problem. Now: flip back to triaged_real,
--      emit finding.reopened, increment reopened_count.
--
-- Stable user dismissals ('false_positive', 'wont_fix') are NOT auto-flipped
-- on recurrence. Those are user policy, not facts about the system. The
-- ledger still records the occurrence so a future analytics pass can spot
-- "this dismissed finding has actually recurred 12 times" patterns.

-- ============== Schema additions ==============

alter table public.findings
  add column if not exists first_seen_at  timestamptz not null default now(),
  add column if not exists reopened_count int         not null default 0;

-- The ALTER fired the default `now()` for existing rows. Correct them to
-- their original creation time so the bookend is meaningful.
update public.findings
   set first_seen_at = created_at
 where first_seen_at > created_at;

-- ============== Occurrence ledger ==============

create table if not exists public.finding_occurrences (
  id          uuid        primary key default gen_random_uuid(),
  finding_id  uuid        not null references public.findings(id) on delete cascade,
  scan_id     uuid        not null references public.scans(id)    on delete cascade,
  org_id      uuid        not null,                 -- denormalized for RLS perf
  seen_at     timestamptz not null default now(),
  -- True if this occurrence flipped a 'fixed' finding back to triaged_real.
  -- Useful for an analytics pass: "how often do our 'fixes' regress?".
  reopened    boolean     not null default false,
  unique (finding_id, scan_id)
);

create index if not exists finding_occurrences_finding
  on public.finding_occurrences (finding_id, seen_at desc);
create index if not exists finding_occurrences_scan
  on public.finding_occurrences (scan_id);
create index if not exists finding_occurrences_org
  on public.finding_occurrences (org_id);

-- Backfill the ledger from existing findings:
--   1. One row from the original scan_id at created_at (first detection)
--   2. One row from last_seen_scan_id at last_seen_at if it differs from #1
-- We can't reconstruct intermediate occurrences for already-deduped rows;
-- the count gap (times_seen vs ledger rows for old findings) is the price
-- of late-adopting the ledger.
insert into public.finding_occurrences (finding_id, scan_id, org_id, seen_at)
select id, scan_id, org_id, created_at from public.findings
on conflict (finding_id, scan_id) do nothing;

insert into public.finding_occurrences (finding_id, scan_id, org_id, seen_at)
select id, last_seen_scan_id, org_id, last_seen_at
  from public.findings
 where last_seen_scan_id is not null and last_seen_scan_id <> scan_id
on conflict (finding_id, scan_id) do nothing;

-- ============== RLS ==============

alter table public.finding_occurrences enable row level security;

-- Read-only for org members. Worker writes via service role through the
-- security-definer RPC below; no INSERT policy exposed to clients.
create policy finding_occurrences_org_read on public.finding_occurrences
  for select to authenticated using (org_id = public.current_org_id());

-- ============== INSERT FINDING (dedup-aware, with reopen + ledger) ==============
--
-- Behaviour:
--   1. Existing finding with same (org_id, fingerprint):
--        a. status = 'fixed'  →  reopen as triaged_real, emit finding.reopened,
--                                bump reopened_count, mark occurrence reopened.
--        b. status in ('open', 'triaged_real')  →  bump times_seen,
--                                emit finding.recurred.
--        c. status in ('false_positive', 'wont_fix')  →  bump times_seen,
--                                no event (stable user decision; the ledger
--                                still records it for later analytics).
--      In every case, write a finding_occurrences row.
--   2. No existing fingerprint  →  insert finding, write first occurrence,
--      emit finding.created.
--
-- Findings without a fingerprint always insert (legacy behaviour, kept for
-- safety) but still get an occurrence row.

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
        -- Regression: a 'fixed' finding is being detected again. Flip back
        -- to triaged_real and clear the prior triage attribution — the
        -- previous "fixed" decision is no longer valid. The user can
        -- explicitly re-triage if they want.
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

        -- Live event only for things the user still cares about. Stable
        -- dismissals stay quiet to keep the event stream calm.
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

      -- Idempotent ledger write — if the worker retries within one scan,
      -- the unique (finding_id, scan_id) constraint absorbs the second hit.
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

  -- The original detection is also an occurrence. Insert it now so the
  -- ledger is the single source of truth for "which scans saw this".
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
