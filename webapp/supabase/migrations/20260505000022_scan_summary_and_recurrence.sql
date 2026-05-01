-- Pillar 1 (AI security engineer surface) — items 5 + 7.
--
-- Two scan-level intelligence surfaces that the wrapper can ship today
-- without waiting for the upstream `run.summary` event:
--
--   1. `scans.summary` (jsonb) — plain-language one-paragraph report
--      written by the worker post-triage and rendered above the findings
--      list. The worker has all the inputs (findings + AI assessments +
--      target metadata) and an LLM key already; one extra acompletion
--      per scan keeps the path coherent with the rest of the pillar.
--
--   2. `scan_recurrence_summary(p_scan_id)` RPC — counts findings
--      detected in this scan that were also seen in *prior* scans, broken
--      down by current state (still-active / fixed / reopened). Reads
--      from `findings` + `finding_occurrences`; no model needed. Rendered
--      as a "we revisited N prior findings" strip on the scan page.
--
--   3. `triage_priors_for_finding(p_finding_id)` RPC — used by the
--      worker before each `assess_one` call to feed prior-decision
--      context into the triage prompt. "This fingerprint has been
--      dismissed 3 times by your team" is strong signal the LLM should
--      see; today the prompt only carries the in-scan finding text.
--
-- All three are wrapper-side because they sit downstream of detection.
-- Strix produces the findings; we layer scan-level intelligence on top.

-- ============== scans.summary ==============
--
-- Shape:
--   {
--     "text": "Scanned 12 endpoints across acme.com. Found 1 critical
--              SSRF (exploit drafted) and 2 medium misconfigurations.",
--     "model": "gemini/gemini-2.5-flash",
--     "generated_at": "2026-05-05T...",
--     "stats": {
--       "findings_total": 3,
--       "fix_now": 1,
--       "fix_soon": 0,
--       "monitor": 0,
--       "dismiss_or_fp": 0,
--       "endpoints_touched": 12   -- derived from scan_events tool calls
--     }
--   }
--
-- Stays null until the worker successfully generates it. Cold scans
-- and scans completed before this migration shipped will have null —
-- the UI degrades gracefully.

alter table public.scans
  add column if not exists summary jsonb;

-- ============== scan_recurrence_summary ==============
--
-- Returns null when this scan has no recurring findings (greenfield
-- scan or first-time target). The UI hides the section in that case.
--
-- "Recurring" = the finding existed before this scan. We detect that
-- via `findings.times_seen > 1` AND this scan was the LATEST one to
-- detect it (`last_seen_scan_id = p_scan_id`).

create or replace function public.scan_recurrence_summary(p_scan_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with recurring as (
    select f.id, f.status, f.reopened_count
      from public.findings f
     where f.last_seen_scan_id = p_scan_id
       and f.times_seen > 1
  )
  select case
    when count(*) = 0 then null
    else jsonb_build_object(
      'total',         count(*)::int,
      'still_active',  count(*) filter (where status in ('open','triaged_real'))::int,
      'fixed',         count(*) filter (where status = 'fixed')::int,
      'dismissed',     count(*) filter (where status in ('false_positive','wont_fix','dismissed_by_ai'))::int,
      -- Reopened-during-this-scan: the finding was 'fixed' before, the
      -- worker auto-flipped it back. Captured in `reopened_count` when
      -- the auto-reopen path fires (see migration 017).
      'reopened',      count(*) filter (where reopened_count > 0)::int
    )
  end
  from recurring;
$$;

grant execute on function public.scan_recurrence_summary(uuid) to authenticated;

-- ============== triage_priors_for_finding ==============
--
-- Feeds the per-finding triage prompt with prior decisions on the same
-- fingerprint. Returns null when there's no prior signal (cold start
-- on this fingerprint).
--
-- Why fingerprint-exact and not "similar"? Two reasons:
--   1. The KNN model already handles similarity via embeddings (Phase
--      2). This RPC is for the orthogonal "what has the user decided
--      on this *exact* recurring issue?" question.
--   2. Exact-match decisions are the strongest signal: if this org has
--      marked this fingerprint false_positive 3 times, that's near-
--      certain; if it's been confirmed real once, it's very real.

create or replace function public.triage_priors_for_finding(p_finding_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with target as (
    select org_id, fingerprint
      from public.findings
     where id = p_finding_id
  ),
  signals as (
    select s.decision, s.decided_at
      from public.triage_signals s
      join public.findings f on f.id = s.finding_id
      join target t on true
     where s.org_id = t.org_id
       and f.fingerprint = t.fingerprint
       and f.fingerprint is not null
       and s.finding_id <> p_finding_id
  )
  select case
    when count(*) = 0 then null
    else jsonb_build_object(
      'total',          count(*)::int,
      'fixed',          count(*) filter (where decision = 'fixed')::int,
      'triaged_real',   count(*) filter (where decision = 'triaged_real')::int,
      'false_positive', count(*) filter (where decision = 'false_positive')::int,
      'wont_fix',       count(*) filter (where decision = 'wont_fix')::int,
      'last_decided_at', max(decided_at)
    )
  end
  from signals;
$$;

grant execute on function public.triage_priors_for_finding(uuid) to authenticated;
-- The worker (service_role) also calls this; service_role can already
-- execute, but explicit grant doesn't hurt.
grant execute on function public.triage_priors_for_finding(uuid) to service_role;
