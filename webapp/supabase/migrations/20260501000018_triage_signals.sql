-- Per-tenant triage signals — the foundation for "the model gets sharper
-- with use".
--
-- Every Fixed / Confirmed-real / False-positive / Won't-fix click on a
-- FindingCard is a labeled training pair. Without persistence, those
-- clicks vanish: `findings.status` carries the *current* state but loses
-- the decision history. This migration captures every status transition
-- a real user makes, in a model-friendly shape, with strict per-org
-- isolation.
--
-- What's NOT captured here (intentionally):
--
--   - Worker auto-flips. The reopen-on-recurrence path in
--     `worker_insert_finding` runs as service_role with `auth.uid() =
--     null` — those flips are facts about the system, not human
--     judgment, and would poison the training set if we treated them as
--     labels. The trigger filters them out.
--
--   - Embeddings. Phase 0 captures the decision + a small feature
--     snapshot; the embedding column comes in a follow-up migration
--     that adds pgvector. The shape we land here is forward-compatible
--     — no need to backfill text content later.
--
-- Privacy: per-org RLS, no INSERT/UPDATE/DELETE policies for clients
-- (the trigger writes via SECURITY DEFINER), signals are immutable
-- once written. The "loop never trains across orgs" promise on the
-- landing page is enforced by construction here.

-- ============== triage_signals ==============

create table if not exists public.triage_signals (
  id              uuid        primary key default gen_random_uuid(),
  finding_id      uuid        not null references public.findings(id) on delete cascade,
  org_id          uuid        not null,                   -- denorm for RLS perf
  decided_by      uuid        references auth.users,      -- nullable: backfill rows have no attribution
  decided_at      timestamptz not null default now(),
  -- Status transition. Both columns mirror the findings.status enum.
  prior_status    text        not null
                    check (prior_status in ('open','triaged_real','false_positive','wont_fix','fixed')),
  decision        text        not null
                    check (decision    in ('open','triaged_real','false_positive','wont_fix','fixed')),
  -- Snapshot of the user's note at the moment of the decision. Useful
  -- training signal AND audit trail (notes can change later).
  triage_notes    text,
  -- Snapshot of `findings.ai_assessment` at decision time. Lets us
  -- measure model-vs-human agreement over time without storing every
  -- assessment revision.
  ai_prediction   jsonb,
  -- Compact feature bag for the cold-start KNN model in phase 2 — small
  -- enough to be fast to read, expressive enough to be informative.
  finding_features jsonb
);

create index if not exists triage_signals_org_decided
  on public.triage_signals (org_id, decided_at desc);
create index if not exists triage_signals_finding
  on public.triage_signals (finding_id);
-- Phase 1 aggregation hits this index — same-CWE / same-target lookups
-- across an org's signals.
create index if not exists triage_signals_org_finding
  on public.triage_signals (org_id, finding_id);

-- ============== RLS ==============

alter table public.triage_signals enable row level security;

-- Read-only for org members. No INSERT/UPDATE/DELETE policies — the
-- trigger writes via SECURITY DEFINER; signals are immutable.
create policy triage_signals_org_read on public.triage_signals
  for select to authenticated using (org_id = public.current_org_id());

-- ============== Trigger: capture user-initiated status changes ==============

create or replace function public._capture_triage_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only capture user-initiated transitions. Worker actions (the
  -- auto-reopen-on-recurrence path) run as service_role with no
  -- auth.uid() and would otherwise poison the training set.
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.triage_signals (
      finding_id, org_id, decided_by, prior_status, decision,
      triage_notes, ai_prediction, finding_features
    ) values (
      new.id, new.org_id, auth.uid(), old.status, new.status,
      new.triage_notes, new.ai_assessment,
      jsonb_build_object(
        'severity',    new.severity,
        'cwe',         new.cwe,
        'cve',         new.cve,
        'cvss',        new.cvss,
        'target',      new.target,
        'endpoint',    new.endpoint,
        'method',      new.method,
        'fingerprint', new.fingerprint
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists findings_capture_triage_signal on public.findings;
create trigger findings_capture_triage_signal
  after update of status on public.findings
  for each row
  execute function public._capture_triage_signal();

-- ============== Backfill from existing triaged findings ==============
--
-- Every finding that's already in a non-`open` state represents a past
-- triage decision. We have no record of what status it was *before*
-- (the column wasn't tracked) — assume `open` as the prior, since
-- that's the default starting state. Decided_by may be null for
-- worker-set states (e.g. auto-reopen flipped `fixed` → `triaged_real`
-- and cleared triaged_by); we still capture the decision but lose the
-- attribution, which is correct: those weren't human triages.

insert into public.triage_signals (
  finding_id, org_id, decided_by, decided_at,
  prior_status, decision, triage_notes, ai_prediction, finding_features
)
select
  id,
  org_id,
  triaged_by,
  coalesce(triaged_at, created_at),
  'open',
  status,
  triage_notes,
  ai_assessment,
  jsonb_build_object(
    'severity',    severity,
    'cwe',         cwe,
    'cve',         cve,
    'cvss',        cvss,
    'target',      target,
    'endpoint',    endpoint,
    'method',      method,
    'fingerprint', fingerprint
  )
from public.findings
where status <> 'open' and triaged_by is not null;

-- ============== Phase 1: cross-finding triage history function ==============
--
-- Given a finding, return a breakdown of what this org has decided on
-- "similar" findings before. Phase 1 defines similar as
-- `same CWE + same target` — coarse but useful, no embeddings needed.
-- Phase 2 will replace this with vector similarity.
--
-- SECURITY INVOKER (the default) means RLS on findings + triage_signals
-- applies to the calling user. A user can only ever pull aggregations
-- across signals for their own org. Cross-org leak is impossible.

create or replace function public.triage_history_for_finding(p_finding_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with target_finding as (
    select org_id, cwe, target from public.findings where id = p_finding_id
  ),
  matches as (
    select s.decision
      from public.triage_signals s
      join public.findings f on f.id = s.finding_id
      join target_finding t on true
     where s.org_id = t.org_id
       and f.cwe is not null and f.cwe = t.cwe
       and (
         (f.target is not null and f.target = t.target)
         or (f.target is null and t.target is null)
       )
       and s.finding_id <> p_finding_id
  )
  select case
    when count(*) = 0 then null
    else jsonb_build_object(
      'total',          count(*)::int,
      'fixed',          count(*) filter (where decision = 'fixed')::int,
      'triaged_real',   count(*) filter (where decision = 'triaged_real')::int,
      'false_positive', count(*) filter (where decision = 'false_positive')::int,
      'wont_fix',       count(*) filter (where decision = 'wont_fix')::int
    )
  end
  from matches;
$$;

grant execute on function public.triage_history_for_finding(uuid) to authenticated;

-- ============== Realtime ==============
-- Triage signals don't need to be live-broadcast — the user already
-- sees their own click reflected in the UI synchronously. But adding
-- to the publication is cheap if a future feature wants it.
-- (Skipped for now — keep the realtime channel calm.)
