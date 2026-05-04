-- Pillar §19 Tier 1.3 — consume the engine's structured per-finding signals.
--
-- The fork at ClatTribe/strix writes vulnerabilities.json with ~27 fields per
-- finding (PR #137 + #142 + earlier). Today our worker parses the per-vuln
-- markdown and only persists ~10 of those. This migration adds the columns
-- so a single ingest-side change to read vulnerabilities.json directly
-- unlocks the full §15.3 + §10 quality surface (confidence, reasoning_trace,
-- counter_proof, reproducibility_token, category, priority_label, etc.).
--
-- Per the Architecture.md §1.1 doctrine ("Strix is the source of truth"),
-- our wrapper-side AI columns (`ai_assessment` from the LLM triage,
-- `embedding` from KNN, `auto_dismiss_reason` from our policy) coexist with
-- but do not override the engine's deterministic signals. The UI prefers
-- engine signals when present and falls back to wrapper signals otherwise.
--
-- All columns are NULLABLE — old findings (created before this migration)
-- have null values; the UI degrades gracefully.

alter table public.findings

  -- Semantic category from the engine's category enum (info_disclosure /
  -- email_security / dns_security / sqli / xss / ssrf / etc.). Replaces
  -- our wrapper-side cwe+keyword bucketing on the frontend.
  add column if not exists category text,

  -- Plain-language description for non-tech readers ("We found the API
  -- documentation page. This isn't broken — it's a normal published
  -- file — but it lists every URL the API exposes…"). Engine writes
  -- this alongside `description` (which stays markdown / technical).
  add column if not exists description_plain text,

  -- One-sentence concrete next action ("Move the spec behind auth, or
  -- accept that it's public and lock the surfaces it documents.").
  add column if not exists recommended_action text,

  -- "fix_now" / "fix_soon" / "monitor" / "informational" / "low_priority".
  -- Engine derives from severity + confidence + KEV + verification.
  add column if not exists priority_label text,

  -- "verified" / "pattern_match" / "inconclusive" / "could_not_verify".
  -- The headline distinction between "real vulnerability" vs "pattern
  -- match — needs a human to confirm". Engine PR #137.
  add column if not exists verification_status text,

  -- 0.0–1.0 engine confidence in the finding. Renders as a confidence
  -- bar; sortable / filterable. Distinct from our wrapper-side AI
  -- triage confidence (which is a downstream review of this finding).
  add column if not exists confidence numeric(3,2),

  -- Stable cross-run dedup key. SHA-256 over (reasoning_trace +
  -- kill_chain + target_state). Two scans of the same target that
  -- produce equivalent findings get the same token; we use it as a
  -- secondary dedup signal alongside `fingerprint`. Engine PR #137.
  add column if not exists reproducibility_token text,

  -- Stable across runs by §11 design. The engine guarantees this is
  -- the same string for "the same finding" across re-scans.
  add column if not exists fingerprint_version int,

  -- For cross-tool dedup — the canonical record among multiple
  -- detectors that found the same finding. Wrapper UI surfaces only
  -- canonical=true rows by default. Engine PR #98.
  add column if not exists is_canonical boolean default true,

  -- "Why we believe this is exploitable" bullets, ≤20 × 320 chars.
  -- Engine PR #137. Stored as a JSONB array of strings.
  add column if not exists reasoning_trace jsonb,

  -- Alternative explanation block: { description, evidence }. The
  -- auditor-grade "we considered this might not be a real finding"
  -- signal. Engine PR #137.
  add column if not exists counter_proof jsonb,

  -- Multi-step kill chain (engine #36). { step_count, chain[] } with
  -- each step having step_number / type (one of 7 enum values:
  -- recon / discovery / exploitation / escalation / lateral_movement
  -- / impact / validation) / description / tool / evidence.
  -- Replaces our wrapper-side time-window heuristic from PR #39.
  add column if not exists kill_chain jsonb,

  -- Compliance-control mapping: { soc2: [...], pci_dss: [...],
  -- hipaa: [...], gdpr: [...], iso_27001: [...], nist_800_53: [...],
  -- owasp: [...] }. Engine PR #103.
  add column if not exists compliance_controls jsonb,

  -- "pii" / "phi" / "pci" / "credentials" / "internal" / null.
  -- Drives the "BREACH NOTIFICATION REQUIRED?" prompt when severity
  -- ≥ medium AND data_classification ∈ {pii, phi, pci, credentials}.
  add column if not exists data_classification text,

  -- List of MITRE ATT&CK technique IDs (e.g. ["T1213", "T1592"]).
  -- Engine PR #66.
  add column if not exists mitre_attack jsonb,

  -- "A01:2021" / "A04:2021" / etc.
  add column if not exists owasp_top_10 text,

  -- "API3:2023" / etc. for API targets.
  add column if not exists owasp_api_top_10 text,

  -- Full features block (RLHF Phase 1 / engine PR #142). Used by the
  -- future FP-classifier scorecard. Schema-versioned by the engine.
  add column if not exists features jsonb,

  -- Engine-side auto-dismiss (RLHF / feedback.jsonl driven). Distinct
  -- from our wrapper-side `dismissed_by_ai` (which is KNN-driven).
  -- These coexist on the same row; UI renders both with different
  -- banners.
  add column if not exists engine_auto_dismissed boolean not null default false,
  add column if not exists engine_auto_dismissal_reason text,
  add column if not exists severity_pre_auto_dismissal text,
  add column if not exists prior_label_attribution jsonb;

-- Indexes that the UI's typical filters will hit.

create index if not exists findings_category
  on public.findings (org_id, category);

create index if not exists findings_priority_label
  on public.findings (org_id, priority_label);

create index if not exists findings_verification_status
  on public.findings (org_id, verification_status);

-- Reproducibility token enables cross-scan threading even when our
-- wrapper-side fingerprint differs (e.g. LLM rewording shifts the
-- title). Index on (org_id, reproducibility_token) so we can
-- aggregate across re-runs.
create index if not exists findings_reproducibility_token
  on public.findings (org_id, reproducibility_token)
  where reproducibility_token is not null;
