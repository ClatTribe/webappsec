// Engine PRs #293 / #294 — cloud attack-path findings.
//
// The engine's CSPM specialist (PR #294) emits an attack-path finding
// for every detected "toxic combination" — a chain of CSPM
// misconfigurations that together form an exploit path
// (public-bucket → tfstate → IAM keys → admin, etc.). This module
// extracts the casefile shape out of a generic Finding row so the UI
// can render it as a Wiz-style hop-chain card instead of a flat
// description.
//
// Engine emission format (per the wrapper-wishlist §17.2):
//   - finding.category   = 'cloud_attack_path'
//   - finding.rule_id    = 'cap_<pattern_id>' (e.g. cap_public_storage_credentials_risk)
//   - finding.features   = { hops, evidence_edges, pattern_id, narrative? }
//   - finding.description_md / poc_md — paragraph narrative
//   - finding.mitre_attack — MITRE technique IDs
//   - finding.remediation_md — remediation accordion content
//
// We read defensively — `features` is the engine's open-shape blob
// (PR #142) and the wrapper doesn't enforce its keys. The parser
// falls back gracefully when individual fields are missing.

import type { Finding } from '@/lib/supabase/types';

export interface AttackPathHop {
  /** Node identifier — usually an ARN, resource key, or
   *  `<resource_type>:<id>` form. */
  key: string;
  /** Optional human-readable label. */
  label?: string;
  /** Node type if known: `resource` / `identity` / `policy` /
   *  `external_principal`. Drives the icon. */
  node_type?: string;
  /** Optional sub-label like the AWS service name. */
  detail?: string;
}

export interface AttackPathEdge {
  from: string;
  to: string;
  /** Edge kind: `exposed_to_internet` / `attached_to` / `can_assume` /
   *  `has_policy` / `grants_access_to`. */
  kind?: string;
  /** Optional finding id or human-readable note proving the edge. */
  evidence?: string;
}

export interface CloudAttackPathCasefile {
  patternId: string;
  hops: AttackPathHop[];
  edges: AttackPathEdge[];
  narrative: string | null;
  mitreTechniques: string[];
  remediation: string | null;
  /** When the casefile derives nothing useful (no hops + no narrative)
   *  this is true so the UI can fall back to the default finding card
   *  render rather than show an empty shell. */
  isEmpty: boolean;
}

/** Returns true when this finding should be rendered with the
 *  attack-path casefile UI instead of the default expanded card. */
export function isAttackPathFinding(finding: Finding): boolean {
  if (finding.category === 'cloud_attack_path') return true;
  // Defensive: the engine has shipped attack paths under cap_* rule
  // IDs since PR #294; category should always be set, but accept
  // rule_id as a fallback signal for the rare engine version that
  // hasn't been stamped yet.
  const vulnId = (finding.vuln_id ?? '').toLowerCase();
  return vulnId.startsWith('cap_');
}

/** Pull the casefile shape out of a Finding row. Never throws — when
 *  a field is missing we return reasonable defaults so the UI can
 *  still render a partial casefile (better than crashing the card). */
export function parseAttackPathCasefile(finding: Finding): CloudAttackPathCasefile {
  const features = (finding.features ?? {}) as Record<string, unknown>;

  const patternId =
    asNonEmptyString(features.pattern_id) ??
    asNonEmptyString(finding.vuln_id) ??
    'unknown';

  const hops = parseHops(features.hops);
  const edges = parseEdges(features.evidence_edges ?? features.edges);

  const narrative =
    asNonEmptyString(features.narrative) ??
    asNonEmptyString(finding.description_md) ??
    asNonEmptyString(finding.description_plain) ??
    null;

  const mitre = Array.isArray(finding.mitre_attack)
    ? (finding.mitre_attack as unknown[])
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter((s): s is string => s.length > 0)
    : [];

  const remediation =
    asNonEmptyString(finding.remediation_md) ??
    asNonEmptyString(features.remediation) ??
    null;

  const isEmpty = hops.length === 0 && !narrative;

  return {
    patternId,
    hops,
    edges,
    narrative,
    mitreTechniques: mitre,
    remediation,
    isEmpty,
  };
}

/** Friendly title for a pattern_id. The engine ships 5 built-ins;
 *  any others fall back to a normalised version of the id. */
export function patternDisplayName(patternId: string): string {
  const normalized = patternId.toLowerCase();
  switch (normalized) {
    case 'cap_public_storage_credentials_risk':
      return 'Public storage with credentials risk';
    case 'cap_internet_exposed_compute_with_iam':
      return 'Internet-exposed compute with IAM';
    case 'cap_wildcard_admin_attached':
      return 'Wildcard admin policy attached';
    case 'cap_root_unsafe':
      return 'Root account with live access keys';
    case 'cap_world_assumable_role':
      return 'World-assumable IAM role';
    default:
      return normalized
        .replace(/^cap_/, '')
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
}

// =============== drift classification (§17.2) =====================
//
// Engine PR #292 emits drift findings with title prefix
// `[drift:iac_root_cause] ...` etc. This is the on-wire signal; our
// `findings.drift_classification` TS-only field is the forward-compat
// path for when the engine eventually adds a dedicated column.
//
// parseDriftClassificationFromTitle pulls the prefix out so the
// DriftBadge can render even when the field is unset.

export type DriftClassification =
  | 'iac_root_cause'
  | 'drift'
  | 'iac_unfollowed'
  | 'uncorrelated_cspm';

const DRIFT_PREFIX_RE = /^\[drift:(iac_root_cause|drift|iac_unfollowed|uncorrelated_cspm)\]\s*/i;

export function parseDriftClassificationFromTitle(
  title: string | null | undefined,
): { classification: DriftClassification | null; cleanedTitle: string } {
  const safe = title ?? '';
  const m = safe.match(DRIFT_PREFIX_RE);
  if (!m) return { classification: null, cleanedTitle: safe };
  return {
    classification: m[1].toLowerCase() as DriftClassification,
    cleanedTitle: safe.replace(DRIFT_PREFIX_RE, ''),
  };
}

/** Resolve the drift classification preferring the dedicated field
 *  (forward-compat) and falling back to the title-prefix parse. */
export function resolveDriftClassification(
  finding: Finding,
): { classification: DriftClassification | null; cleanedTitle: string } {
  if (finding.drift_classification) {
    return {
      classification: finding.drift_classification as DriftClassification,
      // Even when the field is set, strip the prefix from the display
      // title so we don't end up with `[drift:drift] xyz` in the UI.
      cleanedTitle: parseDriftClassificationFromTitle(finding.title).cleanedTitle,
    };
  }
  return parseDriftClassificationFromTitle(finding.title);
}

// =============== helpers ==========================================

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseHops(raw: unknown): AttackPathHop[] {
  if (!Array.isArray(raw)) return [];
  const out: AttackPathHop[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ key: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const key = asNonEmptyString(o.key) ?? asNonEmptyString(o.id) ?? asNonEmptyString(o.arn);
      if (!key) continue;
      out.push({
        key,
        label: asNonEmptyString(o.label) ?? undefined,
        node_type: asNonEmptyString(o.node_type) ?? asNonEmptyString(o.type) ?? undefined,
        detail: asNonEmptyString(o.detail) ?? asNonEmptyString(o.service) ?? undefined,
      });
    }
  }
  return out;
}

function parseEdges(raw: unknown): AttackPathEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: AttackPathEdge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const from = asNonEmptyString(o.from) ?? asNonEmptyString(o.source);
    const to = asNonEmptyString(o.to) ?? asNonEmptyString(o.target);
    if (!from || !to) continue;
    out.push({
      from,
      to,
      kind: asNonEmptyString(o.kind) ?? asNonEmptyString(o.edge_type) ?? undefined,
      evidence: asNonEmptyString(o.evidence) ?? asNonEmptyString(o.finding_id) ?? undefined,
    });
  }
  return out;
}
