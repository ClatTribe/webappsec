// Wrapper-wishlist §18 — per-target-type depth metadata extractors.
//
// Engine PRs #270–#288 added a pile of new metadata fields to the
// finding payload (MOAK exploit synthesis, XSS context, SSRF family,
// BOLA variant, Cosign/SLSA, first-introduced commit, etc.). Most
// of them ride the open-shape `features` JSONB blob (engine PR #142)
// so adding them doesn't require a schema migration on the wrapper
// side.
//
// This module pulls each one out defensively — every field is optional
// and we never throw if the engine didn't write it. Components that
// render the chips read via these helpers so the wrapper has ONE place
// to maintain the field name → semantic shape mapping.

import type { Finding } from '@/lib/supabase/types';

// ============== shared helpers ====================================

function features(f: Finding): Record<string, unknown> {
  const x = f.features;
  return x && typeof x === 'object' ? x : {};
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

// ============== §18.1 — MOAK pipeline ============================

/** Engine PR #278 — when MOAK Phase B3 (LiveProbe) ran against the
 *  production target and the probe succeeded. Distinct from regular
 *  `verification_status='verified'` (which means an in-sandbox
 *  environment build + probe). Wrapper renders a "Live-probed" chip
 *  for this; it's the single most powerful credibility cue we have. */
export function isVerifiedLive(finding: Finding): boolean {
  return (
    asBool(features(finding).verified_live) === true ||
    // Engine sometimes also stamps it as the verification_status value
    // itself rather than a separate flag — accept both.
    (finding.verification_status ?? '').toLowerCase() === 'verified_live'
  );
}

/** Engine PR #270 — path to a content-addressable PoC artifact (dumped
 *  row, IMDS blob, captured flag, cookie). Stored under the run dir;
 *  the wrapper renders a download link off this. */
export function proofArtifactPath(finding: Finding): string | null {
  return asString(features(finding).proof_artifact_path);
}

/** Engine `pivot_orchestrator.run_pivot_chain` writes parent finding
 *  IDs onto pivot-derived findings so the post-exploit narrative is
 *  reconstructable. Wrapper renders these as a breadcrumb chain. */
export function pivotChainAncestors(finding: Finding): string[] {
  const raw = features(finding).pivot_chain_ancestors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ============== §18.2 — XSS / SSRF depth =========================

/** Engine PR #273 — XSS context (html_body / attribute / js / url /
 *  template). Drives the encoding fix recommendation. */
export function xssContext(finding: Finding): string | null {
  return asString(features(finding).xss_context);
}

/** Engine PR #281 — SSRF family chip (aws_imds / gcp_metadata /
 *  azure_imds / internal_dns / filter_bypass / redirect_chain). */
export function ssrfFamily(finding: Finding): string | null {
  return asString(features(finding).ssrf_family);
}

// ============== §18.3 — API depth =================================

/** Engine PR #284 — BOLA variant (exact_hash / partial_leak /
 *  list_endpoint). Drives remediation: exact_hash = resource-level
 *  auth, partial_leak = field-level filtering, list_endpoint =
 *  DB-query-layer filtering. */
export function bolaVariant(finding: Finding): string | null {
  return asString(features(finding).bola_variant);
}

/** Engine PR #282 — mass-assignment schema-aware finding metadata.
 *  Wrapper renders a side-by-side diff: "OpenAPI says ✗ — server
 *  accepted ✓". All three fields optional; the renderer hides itself
 *  if the engine didn't emit the trio. */
export interface MassAssignmentDiff {
  schema_expected?: string;
  accepted_field?: string;
  sample_payload?: string;
}

export function massAssignmentDiff(finding: Finding): MassAssignmentDiff | null {
  const f = features(finding);
  const d = f.mass_assignment_diff ?? f.schema_diff;
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  return {
    schema_expected: asString(o.schema_expected) ?? undefined,
    accepted_field: asString(o.accepted_field) ?? undefined,
    sample_payload: asString(o.sample_payload) ?? undefined,
  };
}

// ============== §18.4 — Container image ===========================

/** Engine PR #283 — single Trivy invocation emits three categories.
 *  Wrapper renders a tab group keyed off this. */
export type ImageFindingCategory = 'sca' | 'misconfig' | 'secrets' | null;

export function imageCategory(finding: Finding): ImageFindingCategory {
  // PR #283 stamps category on either `image_category` or the parent
  // finding.category column. Both are accepted; the former wins.
  const explicit = asString(features(finding).image_category);
  if (explicit === 'sca' || explicit === 'misconfig' || explicit === 'secrets') {
    return explicit;
  }
  const c = (finding.category ?? '').toLowerCase();
  if (c === 'sca' || c === 'misconfig' || c === 'secrets') return c;
  return null;
}

/** Engine PR #286 — Cosign signature + SLSA provenance card. Lives
 *  on the scan's run_meta (not per-finding) so the wrapper renders
 *  this as a top-of-page card on the scan / image report, not on
 *  individual finding cards. The shape is the same whether the
 *  field comes from the finding's features blob (defensive) or
 *  from run_meta. */
export interface SupplyChainAttestation {
  signature_status: 'signed_by_trusted' | 'signed_unknown_issuer' | 'unsigned' | 'unknown';
  slsa_level: 0 | 1 | 2 | 3 | null;
  builder_uri: string | null;
  signed_by: string | null;
}

export function parseSupplyChainAttestation(
  raw: unknown,
): SupplyChainAttestation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sig = asString(o.signature_status);
  if (!sig) return null;
  const slsaRaw = o.slsa_level;
  const slsa =
    typeof slsaRaw === 'number' && [0, 1, 2, 3].includes(slsaRaw)
      ? (slsaRaw as 0 | 1 | 2 | 3)
      : null;
  const sigNorm =
    sig === 'signed_by_trusted' ||
    sig === 'signed_unknown_issuer' ||
    sig === 'unsigned'
      ? sig
      : 'unknown';
  return {
    signature_status: sigNorm,
    slsa_level: slsa,
    builder_uri: asString(o.builder_uri),
    signed_by: asString(o.signed_by) ?? asString(o.signer),
  };
}

// ============== §18.5 — Repository (IaC + secrets) ===============

/** Engine PR #288 — secrets_scan now defaults to scanning git history.
 *  When the secret was committed historically (not in HEAD), the
 *  engine emits the commit metadata so the wrapper can render
 *  "first introduced in <sha> by <author> on <date>" — operationally
 *  critical for the rotation conversation. */
export interface SecretIntroductionTrail {
  commit_sha: string;
  commit_url: string | null;
  author: string | null;
  authored_at: string | null;
  /** When secrets_scan also reports whether it was reachable in HEAD
   *  (vs. removed but still in history). 'still_present' is the
   *  active threat; 'removed_in_history' means the secret was reverted
   *  but the rotation conversation still applies. */
  current_state: 'still_present' | 'removed_in_history' | null;
}

export function secretIntroductionTrail(finding: Finding): SecretIntroductionTrail | null {
  const f = features(finding);
  const block = f.first_introduced_commit ?? f.introduction;
  if (!block || typeof block !== 'object') return null;
  const o = block as Record<string, unknown>;
  const sha = asString(o.sha) ?? asString(o.commit_sha) ?? asString(o.commit);
  if (!sha) return null;
  const cur = asString(o.current_state);
  return {
    commit_sha: sha,
    commit_url: asString(o.commit_url),
    author: asString(o.author),
    authored_at: asString(o.authored_at) ?? asString(o.date),
    current_state:
      cur === 'still_present' || cur === 'removed_in_history' ? cur : null,
  };
}

// ============== SCA reachability ===================================
//
// Engine wishlist §17.6 follow-up — reachability scoring across the
// dependency / call graph. The wrapper reads from
// finding.features.reachability_* defensively so we render the moment
// the engine starts emitting these fields, no schema change needed.
//
// Three signal layers, ordered most-specific to least:
//
//   reachability_tier      'reachable' / 'unreachable' / 'unknown'
//                          The label the engine assigns after taint /
//                          call-graph analysis. Drives the chip + sort.
//
//   reachability_score     0-100. Optional numeric refinement —
//                          higher = more confidently reachable.
//                          Surfaces as a tooltip on the chip.
//
//   reachable_paths        Array of {from, to, evidence?}. Optional
//                          call-graph chain showing how user input
//                          reaches the vulnerable function. Renders
//                          as a breadcrumb in the expanded panel.

export type ReachabilityTier = 'reachable' | 'unreachable' | 'unknown';

export interface ReachablePathHop {
  from: string;
  to: string;
  evidence?: string;
}

export interface ReachabilityInfo {
  tier: ReachabilityTier;
  score: number | null;
  paths: ReachablePathHop[];
  /** Where the engine's analysis terminated — useful for tooltip
   *  context ("limited by missing source maps" / "no entrypoint found"). */
  analysis_note: string | null;
}

/** Returns null when the engine emitted no reachability signal at all.
 *  Renders the chip / panel only when this is non-null. */
export function reachabilityInfo(finding: Finding): ReachabilityInfo | null {
  const f = features(finding);
  const rawTier = asString(f.reachability_tier);
  const rawScore = f.reachability_score;
  const rawPaths = f.reachable_paths;
  const note = asString(f.reachability_note);

  const tier: ReachabilityTier | null =
    rawTier === 'reachable' || rawTier === 'unreachable' || rawTier === 'unknown'
      ? rawTier
      : null;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, rawScore))
      : null;

  // Defensive: if the engine emitted neither tier nor score nor paths,
  // there's nothing reachability-related to render.
  if (!tier && score === null && !Array.isArray(rawPaths)) return null;

  const paths: ReachablePathHop[] = [];
  if (Array.isArray(rawPaths)) {
    for (const item of rawPaths) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const from = asString(o.from);
      const to = asString(o.to);
      if (!from || !to) continue;
      paths.push({
        from,
        to,
        evidence: asString(o.evidence) ?? undefined,
      });
    }
  }

  // Inferred tier when the engine only emitted a numeric score:
  //   >= 70 = reachable
  //   <= 20 = unreachable
  //   middle = unknown
  const inferredTier: ReachabilityTier =
    tier ?? (score !== null && score >= 70
      ? 'reachable'
      : score !== null && score <= 20
        ? 'unreachable'
        : 'unknown');

  return {
    tier: inferredTier,
    score,
    paths,
    analysis_note: note,
  };
}

// ============== §18.6 — Compliance enrichment =====================

/** Engine PR #285 — per-control evidence card metadata. */
export interface ControlEvidence {
  framework: string;
  control_id: string;
  probe_coverage?: number;
  evidence_pointers?: string[];
  remediation_deadline_days?: number;
  control_owner?: string;
  probes_run?: string[];
}

export function parseControlEvidence(raw: unknown): ControlEvidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const framework = asString(o.framework);
  const controlId = asString(o.control_id);
  if (!framework || !controlId) return null;
  return {
    framework,
    control_id: controlId,
    probe_coverage:
      typeof o.probe_coverage === 'number' ? o.probe_coverage : undefined,
    evidence_pointers: Array.isArray(o.evidence_pointers)
      ? (o.evidence_pointers as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : undefined,
    remediation_deadline_days:
      typeof o.remediation_deadline_days === 'number'
        ? o.remediation_deadline_days
        : undefined,
    control_owner: asString(o.control_owner) ?? undefined,
    probes_run: Array.isArray(o.probes_run)
      ? (o.probes_run as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined,
  };
}
