// Tier II #7 — sticky GitHub PR comment composer.
//
// Builds the markdown body that gets posted to a PR after a
// diff-mode scan finishes. Shape goals, in priority order:
//
//   1. Zero-find PRs get a tiny, joyful comment — devs that ship
//      clean code shouldn't be punished with a 30-line wall of
//      "no findings."
//   2. Findings get a severity-sorted table with file links that
//      jump to the exact line on the PR head SHA — devs should
//      be able to triage from GitHub without opening our app.
//   3. Verified fixes (Patcher) get an "Open auto-fix PR" link so
//      the find→fix loop is exactly two clicks.
//   4. A trailing footer with our marker string makes the comment
//      easy to find when re-running (sticky upsert via PATCH).
//
// We deliberately keep the comment under GitHub's 65k char body
// limit by capping the per-finding details list at 15. The full
// list lives in the wrapper UI; PR comment is a digest.

import { SITE_URL } from '@/lib/seo';
import type { Finding, Severity } from '@/lib/supabase/types';

// Sentinel string we embed in an HTML comment so future runs can
// detect "this is the TensorShield sticky comment" without parsing
// any visible content. Stable forever — changing this breaks
// stickiness on every existing PR.
export const STICKY_MARKER = '<!-- tensorshield:sticky:v1 -->';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🟥',
  high: '🟧',
  medium: '🟨',
  low: '🟦',
  info: '⬜',
};

const SEVERITY_WORD: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

interface ComposeInput {
  scan: {
    id: string;
    org_id: string;
    run_name: string;
    status: string;
    created_at: string;
    scan_mode: string;
    diff_base: string | null;
    github_owner: string;
    github_repo: string;
    github_pull_request_number: number;
    github_head_sha: string | null;
  };
  findings: Pick<
    Finding,
    | 'id'
    | 'title'
    | 'severity'
    | 'vuln_id'
    | 'endpoint'
    | 'cwe'
    | 'cve'
    | 'patch_id'
    | 'patch_status'
    | 'patch_pr_url'
    | 'patch_diff'
  >[];
  /** When set, the deeplinks use this URL as the wrapper base. Defaults
   *  to SITE_URL so the comment works in production without config. */
  appUrl?: string;
  /** Optional org slug for prettier deeplinks. When omitted, links use
   *  the UUID. */
  orgSlug?: string;
}

export function composePrComment({
  scan,
  findings,
  appUrl = SITE_URL,
  orgSlug,
}: ComposeInput): string {
  const counts = countBySeverity(findings);
  const total = findings.length;
  const scanPath = orgSlug ? `/${orgSlug}/scans/${scan.id}` : `/scans/${scan.id}`;
  const scanLink = `${appUrl}${scanPath}`;

  // ---- header line + status pill --------------------------------------
  const headerStatus =
    total === 0
      ? '✅ **No security findings on this diff.**'
      : `${verdictEmoji(counts)} **${total} security finding${total === 1 ? '' : 's'} on this diff**`;

  // ---- severity rollup table — collapsed to a single line for zero-find
  //      and a markdown table for non-zero. Visual scan-ability matters
  //      more than absolute compactness here.
  let rollup = '';
  if (total > 0) {
    const cells = SEVERITY_ORDER.filter((s) => counts[s] > 0)
      .map((s) => `${SEVERITY_EMOJI[s]} ${counts[s]} ${SEVERITY_WORD[s]}`)
      .join('  ·  ');
    rollup = `\n${cells}\n`;
  }

  // ---- per-finding list (capped) --------------------------------------
  let details = '';
  if (total > 0) {
    const sorted = [...findings].sort((a, b) => {
      const sa = SEVERITY_ORDER.indexOf(a.severity);
      const sb = SEVERITY_ORDER.indexOf(b.severity);
      return sa - sb;
    });
    const cap = 15;
    const shown = sorted.slice(0, cap);
    const rest = total - shown.length;

    const rows = shown
      .map((f) => renderRow(f, scan, appUrl, orgSlug))
      .join('\n');

    details = `\n<details>\n<summary><strong>Findings (${total})</strong></summary>\n\n${rows}\n${
      rest > 0
        ? `\n_…and ${rest} more — [view all in TensorShield](${scanLink})_\n`
        : ''
    }\n</details>\n`;
  }

  // ---- verified-fix CTA: surfaces only when at least one finding has a
  //      Patcher-proposed diff. Two-click find→fix is the value prop. ----
  const withPatch = findings.filter((f) => f.patch_id && f.patch_diff);
  let patchCta = '';
  if (withPatch.length > 0) {
    const opened = withPatch.filter((f) => f.patch_pr_url);
    if (opened.length > 0) {
      patchCta = `\n💡 **${opened.length} auto-fix PR${opened.length === 1 ? '' : 's'} already opened.** See linked PRs in the findings list above.\n`;
    } else {
      patchCta = `\n💡 **${withPatch.length} finding${withPatch.length === 1 ? '' : 's'}** ${withPatch.length === 1 ? 'has' : 'have'} a verified auto-fix ready. [Open the patch PR from TensorShield →](${scanLink})\n`;
    }
  }

  // ---- footer marker + metadata --------------------------------------
  const baseRef = scan.diff_base ?? 'main';
  const headRef = scan.github_head_sha
    ? scan.github_head_sha.slice(0, 7)
    : 'HEAD';

  const footer = [
    '',
    '---',
    `<sub>${headerEmojiIcon()} Scanned by [TensorShield](${appUrl}) — diff \`${baseRef}…${headRef}\` · [Open scan](${scanLink}) · [Disable for this repo](${appUrl}/settings/integrations)</sub>`,
    STICKY_MARKER,
  ].join('\n');

  return `${headerStatus}\n${rollup}${details}${patchCta}${footer}\n`;
}

function countBySeverity(findings: ComposeInput['findings']): Record<Severity, number> {
  const out: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) {
    if (f.severity in out) out[f.severity] += 1;
  }
  return out;
}

function verdictEmoji(counts: Record<Severity, number>): string {
  if (counts.critical > 0) return '🟥';
  if (counts.high > 0) return '🟧';
  if (counts.medium > 0) return '🟨';
  if (counts.low > 0) return '🟦';
  return '⬜';
}

function headerEmojiIcon(): string {
  return '🛡';
}

function renderRow(
  f: ComposeInput['findings'][number],
  scan: ComposeInput['scan'],
  appUrl: string,
  orgSlug?: string,
): string {
  const sev = `${SEVERITY_EMOJI[f.severity]} **${SEVERITY_WORD[f.severity]}**`;
  const scanPath = orgSlug ? `/${orgSlug}/scans/${scan.id}` : `/scans/${scan.id}`;
  const findingLink = `${appUrl}${scanPath}#finding-${f.id}`;
  const cwe = f.cwe ? ` · \`${f.cwe}\`` : '';
  const cve = f.cve ? ` · \`${f.cve}\`` : '';
  const endpoint = f.endpoint ? ` · \`${truncate(f.endpoint, 60)}\`` : '';

  // Patch state: emoji + short tag, surfaced inline so the dev can
  // see "ready to apply" without expanding the wrapper UI.
  let patchTag = '';
  if (f.patch_pr_url) {
    patchTag = ` · [auto-fix PR opened](${f.patch_pr_url})`;
  } else if (f.patch_status === 'verified') {
    patchTag = ' · 🧰 _verified auto-fix ready_';
  } else if (f.patch_id) {
    patchTag = ' · 🧰 _auto-fix proposed_';
  }

  return `- ${sev} · [${escapeMd(f.title)}](${findingLink})${cwe}${cve}${endpoint}${patchTag}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeMd(s: string): string {
  // Minimal escape — just the brackets that would break the [link]()
  // syntax. The rest of markdown actively renders in GitHub comments,
  // which is fine (devs sometimes use backticks/bold in titles).
  return s.replace(/([\[\]])/g, '\\$1');
}
