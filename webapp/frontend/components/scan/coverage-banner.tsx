import { AlertTriangle, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { ScanCoverage } from '@/lib/supabase/types';

// CoverageBanner — Tier A trust-gap fix (migration 039 / PR #64).
//
// A 0-finding scan is ambiguous between two very different states:
//   1. "Site is clean — engine ran every required check and found nothing"
//   2. "Agent terminated early — required checks didn't run at all"
//
// The wrapper used to render both as `summary_text: "...with no findings"`
// and `vendor_risk: 100/100 low_risk`, which led customers to assume
// thoroughness from a 0-finding report. coverage.json is the engine's
// own verdict on whether (1) or (2) happened, and this banner makes the
// distinction visible.
//
// Three rendering modes (in priority order):
//
//   - status="incomplete" (gaps non-empty)   → AMBER warning
//   - coverage_percent < 50% (thin scan)     → AMBER warning (catch-all)
//   - status="complete"                      → no banner (implicit positive)
//   - missing/unknown coverage              → no banner (older engines)
//
// Per Architecture.md §1.1 — the engine writes coverage.json, the
// wrapper reads it verbatim. We don't recompute coverage percent
// or reclassify gaps here.

interface Props {
  coverage: ScanCoverage;
  /** Total finding count for the scan — used to colour the banner
   *  copy. Zero findings + incomplete coverage is the dangerous state
   *  the customer can be misled by; the banner explicitly calls
   *  this out. */
  findingCount?: number;
}

const CATEGORY_FRIENDLY: Record<string, string> = {
  csrf:           'CSRF',
  idor:           'IDOR / object-level auth',
  open_redirect:  'open redirect',
  sqli:           'SQL injection',
  ssrf:           'SSRF',
  xss:            'XSS',
  cmd_injection:  'command injection',
  authn:          'authentication',
  authz:          'authorisation',
  crypto:         'cryptography',
  csp:            'content security policy',
  cookies:        'cookie flags',
  cors:           'CORS',
  headers:        'security headers',
  path_traversal: 'path traversal',
  misconfig:      'misconfiguration',
};

function friendly(cat: string): string {
  return CATEGORY_FRIENDLY[cat] ?? cat.replace(/_/g, ' ');
}

export default function CoverageBanner({ coverage, findingCount = 0 }: Props) {
  const status = typeof coverage.status === 'string' ? coverage.status : '';
  const pct =
    typeof coverage.coverage_percent === 'number' && Number.isFinite(coverage.coverage_percent)
      ? Math.max(0, Math.min(100, coverage.coverage_percent))
      : null;
  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps.filter((g): g is string => typeof g === 'string') : [];
  const required = Array.isArray(coverage.required)
    ? coverage.required.filter((g): g is string => typeof g === 'string')
    : [];
  const covered = Array.isArray(coverage.covered)
    ? coverage.covered.filter((g): g is string => typeof g === 'string')
    : [];

  // Decide the rendering mode. We prefer the engine's explicit `status`
  // field; fall back to coverage_percent when status is missing.
  const isIncomplete =
    status.toLowerCase() === 'incomplete'
    || (pct !== null && pct < 100 && gaps.length > 0);
  const isThin = pct !== null && pct < 50 && pct >= 0;
  const isComplete = status.toLowerCase() === 'complete' || (pct !== null && pct >= 100 && gaps.length === 0);

  // Implicit positive — no banner. Operators who want to verify
  // coverage deliberately can still drill into the per-phase
  // PhaseProgress strip.
  if (isComplete) return null;

  // Older engines or non-pentest target types may not emit coverage at
  // all (we don't render an empty state for those — the absence of the
  // banner implies "we have no opinion").
  if (!isIncomplete && !isThin) return null;

  const zeroFindings = findingCount === 0;
  const Icon = isThin || zeroFindings ? AlertTriangle : ShieldAlert;

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" strokeWidth={2.25} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-medium text-amber-100">
              {zeroFindings
                ? 'Coverage incomplete — a 0-finding result is not the same as "clean"'
                : 'Coverage incomplete — some required checks did not run'}
            </h2>
            {pct !== null && (
              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-amber-200 ring-1 ring-amber-400/30">
                {pct.toFixed(0)}% covered
              </span>
            )}
            {covered.length > 0 && required.length > 0 && (
              <span className="font-mono text-[11px] text-amber-200/60">
                {covered.length} / {required.length} categories
              </span>
            )}
          </div>
          {gaps.length > 0 && (
            <p className="text-[12px] leading-relaxed text-amber-200/80">
              The engine&apos;s required-checks list for this scan contained{' '}
              <span className="font-medium text-amber-100">{required.length}</span>{' '}
              categories; the agent did not exercise{' '}
              <span className="font-medium text-amber-100">{gaps.length}</span>{' '}
              of them:{' '}
              <span className="font-mono text-amber-100">
                {gaps.slice(0, 8).map(friendly).join(', ')}
                {gaps.length > 8 && ` … +${gaps.length - 8} more`}
              </span>
              .
            </p>
          )}
          <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200/80 ring-1 ring-amber-400/20">
            {zeroFindings ? (
              <>
                <span className="font-semibold text-amber-100">What this means:</span>{' '}
                a 0-finding result here is <em>not</em> a clean bill of health —
                it just means the agent didn&apos;t actually run those checks.
                Re-run with a longer time budget, deeper scan mode, or
                pre-loaded HAR/Burp traffic to push the coverage above 100%
                before treating the result as authoritative.
              </>
            ) : (
              <>
                <span className="font-semibold text-amber-100">What this means:</span>{' '}
                some findings landed, but other categories weren&apos;t exercised
                — the report is partial, not exhaustive. Treat the absence of
                findings in the missed categories as &ldquo;unknown,&rdquo; not
                &ldquo;safe.&rdquo;
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

// Small helper for surfaces that DON'T want a full banner but want a
// one-line pill (used inside VendorRiskGauge etc.). Returns null for
// complete coverage.
export function CoverageMutedPill({ coverage }: { coverage: ScanCoverage }) {
  const status = typeof coverage.status === 'string' ? coverage.status.toLowerCase() : '';
  const pct =
    typeof coverage.coverage_percent === 'number' && Number.isFinite(coverage.coverage_percent)
      ? coverage.coverage_percent
      : null;
  const isIncomplete = status === 'incomplete' || (pct !== null && pct < 100);
  if (!isIncomplete) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30"
      title="Engine reported coverage incomplete — see the amber banner above the scan card for details"
    >
      <ShieldCheck className="h-2.5 w-2.5" strokeWidth={2.5} />
      coverage caveat
    </span>
  );
}
