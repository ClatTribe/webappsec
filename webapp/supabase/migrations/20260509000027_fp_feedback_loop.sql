-- §19.2 Tier 2 closure — close the FP feedback loop with the engine.
--
-- The engine reads exactly one structured artifact from the wrapper:
-- feedback.jsonl. Today our triage UI updates findings.status (and writes a
-- triage_signals row via the migration-018 trigger) but never produces the
-- engine-readable file. Result: the engine re-emits the same FPs every
-- scan, and our wrapper-side auto-dismiss (KNN) never agrees with the
-- engine's auto-dismiss (label-precedent).
--
-- This migration:
--
--   1. Adds `organizations.fp_auto_dismiss_policy` (`conservative` /
--      `aggressive` / `off`). Forwarded to Strix as STRIX_FP_AUTO_DISMISS.
--
--   2. Adds an `fp_reason` column to `triage_signals` (the engine's closed
--      enum from feedback_loader._VALID_FP_REASONS).  Default null;
--      worker fills with "other" when the user picks FP without choosing
--      a specific reason.
--
--   3. Adds a SECURITY DEFINER RPC `worker_feedback_jsonl_for_org` that
--      returns the org's labels in the engine's feedback.jsonl shape.
--      Used by the worker on scan start to write the per-run artifact.

-- ============== Policy + reason columns ==============

alter table public.organizations
  add column if not exists fp_auto_dismiss_policy text
    not null default 'conservative'
    check (fp_auto_dismiss_policy in ('conservative', 'aggressive', 'off'));

alter table public.triage_signals
  add column if not exists fp_reason text;

-- The engine's closed enum (usage.md §4.1 / feedback_loader._VALID_FP_REASONS).
-- Free-text would let bad data propagate; constrain to the known set.
alter table public.triage_signals
  drop constraint if exists triage_signals_fp_reason_check;
alter table public.triage_signals
  add constraint triage_signals_fp_reason_check check (
    fp_reason is null or fp_reason in (
      'input_properly_encoded',
      'framework_default_blocked',
      'csrf_token_validated',
      'auth_enforced',
      'not_reflected',
      'different_origin',
      'out_of_scope',
      'false_positive_signature',
      'compensating_control',
      'intended_behavior',
      'test_fixture',
      'deprecated_path',
      'other'
    )
  );

-- ============== Feedback writeback RPC ==============
--
-- Returns the org's complete label set in the shape feedback_loader
-- expects. The worker calls this once per scan, writes the result to
-- <run_dir>/feedback.jsonl, and passes --feedback-from.
--
-- The shape:
--   {
--     "schema_version": 1,
--     "finding_fingerprint": "...",
--     "verdict": "tp" | "fp" | "partial_tp" | "needs_review" | "out_of_scope",
--     "fp_reason": "..." | null,
--     "severity_correction": null,
--     "notes": null,                   -- engine strips on attribution
--     "labeler": {"id": "user@…", "role": "…"},
--     "labeled_at": "<ISO>",
--     "scan_run_id": "<scan-id>",
--     "label_id": "<signal-uuid>"
--   }
--
-- We map the wrapper's status enum to the engine's verdict enum:
--   triaged_real | fixed         → tp
--   false_positive               → fp
--   wont_fix                     → fp + fp_reason="compensating_control"
--   dismissed_by_ai              → skipped (wrapper-side automation, not user verdict)
--
-- Only includes signals decided by a real user (decided_by IS NOT NULL).

create or replace function public.worker_feedback_jsonl_for_org(p_org_id uuid)
returns table (record jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with mapped as (
    select
      s.id,
      s.decided_at,
      s.fp_reason,
      s.triage_notes,
      f.fingerprint,
      f.scan_id,
      coalesce(u.email, s.decided_by::text) as labeler_id,
      m.role as labeler_role,
      case s.decision
        when 'triaged_real' then 'tp'
        when 'fixed' then 'tp'
        when 'false_positive' then 'fp'
        when 'wont_fix' then 'fp'
        else null
      end as verdict,
      case s.decision
        when 'wont_fix' then coalesce(s.fp_reason, 'compensating_control')
        when 'false_positive' then coalesce(s.fp_reason, 'other')
        else null
      end as effective_fp_reason
    from public.triage_signals s
    join public.findings f on f.id = s.finding_id
    left join auth.users u on u.id = s.decided_by
    left join public.org_members m on m.user_id = s.decided_by and m.org_id = s.org_id
    where s.org_id = p_org_id
      and s.decided_by is not null
      and f.fingerprint is not null
  )
  select
    jsonb_build_object(
      'schema_version', 1,
      'finding_fingerprint', fingerprint,
      'verdict', verdict,
      'fp_reason', effective_fp_reason,
      'severity_correction', null,
      'notes', null,
      'labeler', jsonb_build_object(
        'id', labeler_id,
        'role', coalesce(labeler_role, 'member')
      ),
      'labeled_at', to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'scan_run_id', scan_id::text,
      'label_id', id::text
    ) as record
  from mapped
  where verdict is not null
  order by decided_at asc;
$$;

revoke execute on function public.worker_feedback_jsonl_for_org(uuid)
  from public, anon, authenticated;
grant   execute on function public.worker_feedback_jsonl_for_org(uuid)
  to service_role;
