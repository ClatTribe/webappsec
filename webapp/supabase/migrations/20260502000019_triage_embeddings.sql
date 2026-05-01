-- Triage learning, phase 2: pgvector embeddings + per-org KNN inference.
--
-- Phase 1 shipped a deterministic SQL aggregation over signals matching
-- exact CWE + target. Useful and shipping today, but limited:
--
--   - "SQLi in /api/v1/users" and "SQL injection in /api/v1/orders"
--     have the same intent but different fingerprints — exact-match
--     misses them.
--   - The aggregation is descriptive, not predictive: "10 of 14 similar
--     findings dismissed" is information, but the user still has to
--     decide whether *this* finding is similar enough to act on.
--
-- This migration adds the model:
--
--   1. `findings.embedding` and `triage_signals.embedding` — vectors
--      from the Gemini text-embedding-004 model (768 dims, free tier on
--      the same key the org already uses for triage).
--   2. The trigger from migration 018 now also copies the finding's
--      embedding into the signal at insert time. Denormalised for
--      faster KNN — no join needed during prediction.
--   3. `predict_triage_for_finding(p_finding_id) → jsonb` does cosine-
--      similarity KNN over this org's signals and returns probability
--      estimates: `{n_neighbours, mean_similarity, p_false_positive,
--      p_real}`. Used by the Phase 3 confidence-display + auto-dismiss
--      UIs.
--
-- The Phase 1 `triage_history_for_finding` function stays — it's still
-- used by the "Your team's pattern" UI, which benefits from being
-- *interpretable* ("here are 12 exact-match decisions") in a way
-- vector-similarity isn't. The two functions serve different purposes.
--
-- Per-org isolation: same as Phase 1 — RLS on the source tables, both
-- functions are SECURITY INVOKER, the user's org_id filter is implicit.
-- No way to cross orgs by construction.

-- ============== pgvector ==============

create extension if not exists vector with schema extensions;

-- ============== Embedding columns ==============
--
-- 768 dims = Gemini text-embedding-004 / OpenAI text-embedding-3-small
-- (default 768). If we switch providers later, the column type stays;
-- only the embedding source changes.

alter table public.findings
  add column if not exists embedding extensions.vector(768);

alter table public.triage_signals
  add column if not exists embedding extensions.vector(768);

-- No HNSW/IVFFlat index yet. At our current scale (per-org row counts
-- in the 10s to low 1000s), a sequential scan with a `where org_id =`
-- predicate index is fast enough. We add an ANN index if/when KNN
-- starts dominating the query plan — separate migration, no rush.

-- ============== Trigger update: copy embedding into the signal ==============
--
-- A finding's embedding is the right embedding for "what the user
-- decided about". Copying into the signal at trigger time avoids a
-- join during prediction and lets us archive findings without losing
-- the labelled vector.

create or replace function public._capture_triage_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.triage_signals (
      finding_id, org_id, decided_by, prior_status, decision,
      triage_notes, ai_prediction, finding_features, embedding
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
      ),
      new.embedding
    );
  end if;
  return new;
end;
$$;

-- ============== predict_triage_for_finding(uuid) ==============
--
-- KNN over the org's labelled signals. Returns aggregate probabilities
-- and metadata — the caller (UI in Phase 3, scripts elsewhere) decides
-- the threshold for auto-dismiss / suggestion / surface-as-priority.
--
-- Returns null when the finding has no embedding (worker hadn't run
-- yet) or when the org has no labelled signals to compare against
-- (cold start). Both are honest "we don't know yet" answers.

-- Note the search_path: pgvector lives in the `extensions` schema (per
-- our `create extension ... with schema extensions` above), so the
-- `<=>` cosine-distance operator isn't resolvable from `public` alone.
-- Include both so the function can use vector operators.
create or replace function public.predict_triage_for_finding(p_finding_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  v_org_id uuid;
  v_emb extensions.vector(768);
  v_n int;
  v_mean_sim numeric;
  v_dismissed int;
  v_real int;
begin
  -- RLS on findings means: if the caller can't see this finding, we
  -- get no row, return null, no leak. Same for triage_signals below.
  select org_id, embedding into v_org_id, v_emb
    from public.findings where id = p_finding_id;

  if v_emb is null or v_org_id is null then
    return null;
  end if;

  with neighbours as (
    select s.decision,
           1 - (s.embedding <=> v_emb) as similarity
      from public.triage_signals s
     where s.org_id = v_org_id
       and s.embedding is not null
       and s.finding_id <> p_finding_id
     order by s.embedding <=> v_emb
     limit 10
  )
  select
    count(*),
    coalesce(avg(similarity), 0)::numeric(4,3),
    count(*) filter (where decision in ('false_positive','wont_fix')),
    count(*) filter (where decision in ('triaged_real','fixed'))
  into v_n, v_mean_sim, v_dismissed, v_real
  from neighbours;

  if v_n = 0 then
    return null;
  end if;

  return jsonb_build_object(
    'n_neighbours',     v_n,
    'mean_similarity',  v_mean_sim,
    'p_false_positive', round((v_dismissed::numeric / v_n)::numeric, 3),
    'p_real',           round((v_real::numeric / v_n)::numeric, 3)
  );
end;
$$;

grant execute on function public.predict_triage_for_finding(uuid) to authenticated;
