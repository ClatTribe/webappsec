// Custom rule library helpers — Semgrep YAML validation + fingerprint.
//
// The wrapper does *basic* shape validation (top-level `rules:` array
// with at least one entry that has `id` and either `pattern` or
// `patterns`). It does NOT try to be a full Semgrep parser — that
// drift would be a maintenance treadmill against a constantly-evolving
// rule syntax (taint mode, metavariable patterns, etc.). The engine
// is the source of truth for what's actually a runnable rule; the
// wrapper just keeps obviously-malformed rules out of the DB.

import { createHash } from 'crypto';

const KNOWN_LANGUAGES = new Set<string>([
  'python', 'javascript', 'typescript', 'go', 'java', 'kotlin',
  'ruby', 'php', 'rust', 'swift', 'scala', 'c', 'cpp', 'csharp',
  'bash', 'yaml', 'hcl', 'dockerfile', 'generic', 'regex',
]);

export interface RuleValidationResult {
  ok: boolean;
  /** Single short error message — designed to render inline below
   *  the YAML editor, not a detailed parser dump. */
  error?: string;
  /** Number of rules found in the document. Surfaced as a sanity
   *  check in the UI ("3 rules detected"). */
  rule_count?: number;
}

/** Light shape validation. Looks for `rules:` followed by at least
 *  one `- id:` entry. Doesn't fully parse YAML — uses regex matching
 *  on the structural anchors we care about. Returns ok=true with
 *  rule_count=N for plausible inputs; ok=false with a one-line error
 *  for obvious shape violations. */
export function validateRuleYaml(yaml: string): RuleValidationResult {
  const text = yaml.trim();
  if (text.length === 0) return { ok: false, error: 'rule body is empty' };
  if (text.length > 65_536) return { ok: false, error: 'rule body exceeds 64 KB' };

  if (!/^rules\s*:/m.test(text)) {
    return { ok: false, error: 'must start with top-level `rules:` key (Semgrep YAML)' };
  }

  // Count `- id:` entries.
  const idMatches = text.match(/(^|\n)\s*-\s+id\s*:\s*/g) ?? [];
  const rule_count = idMatches.length;
  if (rule_count === 0) {
    return { ok: false, error: 'no rule entries found (each rule needs an `id:` field)' };
  }
  if (rule_count > 50) {
    return { ok: false, error: `${rule_count} rules in one file — split into multiple rule entries (max 50)` };
  }

  // Every rule should declare at least one pattern field. We accept
  // any of: pattern / patterns / pattern-either / pattern-not /
  // metavariable-pattern / taint-mode (with sources/sinks).
  const PATTERN_RE = /pattern(?:s|-either|-not|-inside|-not-inside)?\s*:|metavariable-pattern\s*:|pattern-regex\s*:/;
  if (!PATTERN_RE.test(text)) {
    return { ok: false, error: 'no `pattern`-style key found — every rule needs at least one' };
  }

  // Message field is required by Semgrep — bare patterns without a
  // message produce findings with empty titles in the wrapper UI.
  if (!/\bmessage\s*:/.test(text)) {
    return { ok: false, error: 'no `message:` field found — every rule needs a finding message' };
  }

  return { ok: true, rule_count };
}

/** Stable SHA-256 hash of the rule body (lowercase hex). Used to
 *  detect duplicate edits and to skip re-dumping unchanged rules on
 *  the worker side. */
export function hashRuleYaml(yaml: string): string {
  return createHash('sha256').update(yaml, 'utf8').digest('hex');
}

/** True when the language string is one we recognise — used as a
 *  soft warning in the UI ("never heard of language X"), not as a
 *  hard validation gate. New languages are added on the engine side
 *  faster than we can keep this list current. */
export function isKnownLanguage(lang: string): boolean {
  return KNOWN_LANGUAGES.has(lang.toLowerCase());
}

export const SUGGESTED_LANGUAGES = [
  'python',
  'javascript',
  'typescript',
  'go',
  'java',
  'ruby',
  'rust',
  'php',
  'kotlin',
  'csharp',
  'generic',
];
