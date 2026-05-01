-- Triage learning, phase 3: surface a new `dismissed_by_ai` status so
-- auto-dismissed findings are auditable and reversible.
--
-- Why a separate status (vs. reusing `false_positive` or `wont_fix`):
--
--   * Reversibility. The user must be able to find what the AI hid and
--     undo it in one click. A separate status makes that filter trivial.
--   * Attribution. `false_positive` and `wont_fix` are user policy
--     decisions; auto-dismiss is the system's. Conflating them poisons
--     the training set when (a future) drift-detection job audits FPs.
--   * Catastrophe boundary. We never auto-dismiss `severity='critical'`
--     (hard floor in the worker). A separate status makes that policy
--     explicit and easy to verify.
--
-- The trigger from migration 018 already filters out service_role
-- updates (`auth.uid() is null`), so worker-initiated auto-dismiss
-- transitions don't generate triage_signals. That's intentional — they
-- aren't human labels. If the user later overrides (status flip via
-- the UI), THAT transition does generate a signal — exactly the
-- active-learning loop we want.

-- ============== Status enum: add dismissed_by_ai ==============

alter table public.findings
  drop constraint findings_status_check;

alter table public.findings
  add constraint findings_status_check
  check (status in ('open','triaged_real','false_positive','wont_fix','fixed','dismissed_by_ai'));

-- The trigger from migration 018 references the same enum literals via
-- check constraints on triage_signals. Update those too so a user
-- override of an AI dismissal can land cleanly.

alter table public.triage_signals
  drop constraint triage_signals_prior_status_check,
  drop constraint triage_signals_decision_check;

alter table public.triage_signals
  add constraint triage_signals_prior_status_check
    check (prior_status in ('open','triaged_real','false_positive','wont_fix','fixed','dismissed_by_ai')),
  add constraint triage_signals_decision_check
    check (decision    in ('open','triaged_real','false_positive','wont_fix','fixed','dismissed_by_ai'));

-- ============== Audit trail ==============
--
-- When the worker auto-dismisses, store the prediction snapshot and
-- the policy decision (epsilon-greedy outcome, threshold used). This
-- is what the UI surfaces in the "AI auto-dismissed — N of M similar
-- findings were dismissed by your team" banner, and what a future
-- drift-detection pass uses to audit auto-dismiss accuracy.
--
-- Shape (jsonb, all optional but typically populated together):
--   {
--     "p_false_positive": 0.97,
--     "n_neighbours": 14,
--     "mean_similarity": 0.83,
--     "threshold": 0.95,
--     "decided_at": "2026-05-03T...",
--     "epsilon_explore": false   -- if true, we *would* have dismissed
--                                -- but the ε-greedy escape valve fired
--                                -- and we surfaced anyway. Stays NULL on
--                                -- non-explore decisions.
--   }

alter table public.findings
  add column if not exists auto_dismiss_reason jsonb;
