'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown,
  CheckCircle2,
  XCircle,
  Eye,
  Loader2,
  RotateCcw,
  Sparkles,
  Repeat,
  History,
  RefreshCw,
  Brain,
  Footprints,
} from 'lucide-react';
import type {
  Finding,
  FindingStatus,
  KillChainResponse,
  KillChainStep,
  KillChainStepEngine,
  TriageHistory,
  TriagePrediction,
} from '@/lib/supabase/types';
import { createClient } from '@/lib/supabase/client';
import {
  AI_BRAND,
  REACHABILITY_THEME,
  SEVERITY_THEME,
  STATUS_THEME,
  URGENCY_THEME,
  getCategoryTheme,
} from '@/lib/finding-theme';

// FindingCard — collapsed-state design follows a single-signal rule:
//   - Severity is communicated *only* by the left-edge gradient band.
//   - Title is the hero. Two-line max.
//   - AI urgency pill on the right is the single action signal.
//   - The AI one-liner ("why it matters / what to do") is surfaced by default
//     so users can decide without expanding.
//   - Status, CVSS, CWE, repeat count, HTTP method/endpoint live in the
//     expanded view as metadata. They were creating noise on every row.
//
// The point: a busy finding list should *look* calm. Severity is in the
// peripheral band; the foreground tells you what to do.

const SECTION_LABELS: Record<string, string> = {
  description: 'What is the issue',
  impact: 'Why it matters',
  'technical analysis': 'Technical details',
  'proof of concept': 'How it could be exploited',
  remediation: 'How to fix it',
  'code analysis': 'Affected code',
};

interface ParsedFinding {
  summary: string;
  sections: { heading: string; friendly: string; body: string }[];
}

function parseFindingMarkdown(md: string | null): ParsedFinding {
  if (!md) return { summary: '', sections: [] };
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('## ')) i++;

  const sections: ParsedFinding['sections'] = [];
  while (i < lines.length) {
    const heading = lines[i].replace(/^##\s+/, '').trim();
    const friendly = SECTION_LABELS[heading.toLowerCase()] ?? heading;
    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('## ')) {
      body.push(lines[i]);
      i++;
    }
    sections.push({ heading, friendly, body: body.join('\n').trim() });
  }
  const desc = sections.find((s) => s.heading.toLowerCase() === 'description');
  const firstPara = (desc?.body ?? '').split(/\n\s*\n/)[0] ?? '';
  return { summary: firstPara.trim(), sections };
}

/**
 * The findings page query joins `last_seen_scan` and `finding_occurrences`
 * onto each row. The card uses these to render the cross-scan lifespan
 * without an extra fetch — see migration 017 for the data shape.
 */
export type FindingForCard = Finding & {
  last_seen_scan?: { run_name: string } | null;
  finding_occurrences?: {
    scan_id: string;
    seen_at: string;
    reopened: boolean;
    scans?: { run_name: string } | null;
  }[] | null;
};

interface Props {
  finding: FindingForCard;
  defaultExpanded?: boolean;
}

export default function FindingCard({ finding: initial, defaultExpanded = false }: Props) {
  const [finding, setFinding] = useState<FindingForCard>(initial);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [updating, setUpdating] = useState(false);

  const sev = SEVERITY_THEME[finding.severity];
  const statusTheme = STATUS_THEME[finding.status];
  const ai = finding.ai_assessment ?? null;
  const urgencyTheme = ai ? URGENCY_THEME[ai.urgency] : null;
  const reachTheme = ai ? REACHABILITY_THEME[ai.reachability] : null;
  const { summary, sections } = parseFindingMarkdown(finding.description_md);
  const SevIcon = sev.Icon;
  const StatusIcon = statusTheme.Icon;
  const isResolved =
    finding.status === 'fixed' ||
    finding.status === 'false_positive' ||
    finding.status === 'wont_fix';
  const aiDismissed = ai?.urgency === 'dismiss';
  const muted = isResolved || aiDismissed;

  // What we surface as the "AI one-liner" — prefer recommended_action, then
  // reasoning, then the parsed description summary. We want one calm sentence
  // by default, not three pills competing for attention.
  const aiOneLiner = ai?.recommended_action || ai?.reasoning || summary;

  // Cross-scan history. The occurrence ledger is the source of truth — sort
  // ascending so the timeline reads "first → last" naturally.
  const occurrences = (finding.finding_occurrences ?? [])
    .slice()
    .sort((a, b) => a.seen_at.localeCompare(b.seen_at));
  const occurrenceCount = occurrences.length;
  const reopenedCount = finding.reopened_count ?? 0;
  // We use the ledger row count for "seen in N scans" (it's per-scan unique),
  // not `times_seen` which counts every worker report — including retries
  // within a single scan.
  const isRecurring = occurrenceCount > 1 || reopenedCount > 0;

  // Cross-finding triage history: lazy-fetch on expand. Returns an aggregated
  // breakdown ("you've decided on N similar findings before — X dismissed, Y
  // confirmed real") for findings sharing the same CWE + target. The RPC
  // respects RLS, so a user only ever sees their own org's signal. Cached
  // per finding-id in component state — cheap, only fetched when needed.
  const [triageHistory, setTriageHistory] = useState<TriageHistory | null>(null);
  const [triageHistoryLoaded, setTriageHistoryLoaded] = useState(false);
  // Per-org KNN prediction (vector-similarity) — distinct from triageHistory
  // (exact-match aggregation). Used for the confidence badge + the "Likely
  // FP — confirm?" suggestion banner. Lazy-fetched alongside the history.
  const [prediction, setPrediction] = useState<TriagePrediction | null>(null);
  const [predictionLoaded, setPredictionLoaded] = useState(false);
  // Kill-chain timeline. The engine's deterministic version lives directly
  // on `finding.kill_chain` (PR #42 ingest path); when it's null we fall
  // back to the heuristic via `kill_chain_for_finding` RPC. The
  // heuristic-fetch is gated behind absence of engine data so we don't
  // make a needless round-trip when the engine already populated it.
  const engineKillChain = finding.kill_chain ?? null;
  const [killChain, setKillChain] = useState<KillChainResponse | null>(null);
  const [killChainLoaded, setKillChainLoaded] = useState(!!engineKillChain);
  useEffect(() => {
    if (!expanded || (triageHistoryLoaded && predictionLoaded && killChainLoaded)) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // Skip the heuristic kill_chain RPC when engine data is already present.
      const fetchHeuristicKillChain = !killChainLoaded && !engineKillChain;
      const [historyRes, predRes, chainRes] = await Promise.all([
        triageHistoryLoaded
          ? Promise.resolve({ data: triageHistory })
          : supabase.rpc('triage_history_for_finding', { p_finding_id: finding.id }),
        predictionLoaded
          ? Promise.resolve({ data: prediction })
          : supabase.rpc('predict_triage_for_finding', { p_finding_id: finding.id }),
        fetchHeuristicKillChain
          ? supabase.rpc('kill_chain_for_finding', { p_finding_id: finding.id })
          : Promise.resolve({ data: null }),
      ]);
      if (cancelled) return;
      if (!triageHistoryLoaded) {
        setTriageHistory((historyRes.data as TriageHistory | null) ?? null);
        setTriageHistoryLoaded(true);
      }
      if (!predictionLoaded) {
        setPrediction((predRes.data as TriagePrediction | null) ?? null);
        setPredictionLoaded(true);
      }
      if (!killChainLoaded) {
        setKillChain((chainRes.data as KillChainResponse | null) ?? null);
        setKillChainLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, triageHistoryLoaded, predictionLoaded, killChainLoaded, finding.id]);

  // Suggestion threshold: surface a "Likely false positive — confirm?"
  // prompt when the model is fairly sure but not auto-dismiss-sure.
  // Worker uses 0.95 to auto-dismiss; we surface the suggestion in the
  // 0.70 – 0.95 band so the user is in the loop on borderline cases.
  const PRED_SUGGESTION_THRESHOLD = 0.7;
  const showFpSuggestion =
    prediction !== null
    && finding.status === 'open'
    && prediction.p_false_positive >= PRED_SUGGESTION_THRESHOLD
    && prediction.p_false_positive < 0.95;

  // Active learning band: when the model is genuinely 50/50, the marginal
  // information gain from a user click is highest — that's where we most
  // want their input. Show a calm hint (not action buttons; the existing
  // triage UI does the work) so the user knows their decision matters.
  // Requires at least 5 neighbours so we don't ping the user with
  // "we're not sure" on the first finding of every kind.
  const showActiveLearningHint =
    prediction !== null
    && finding.status === 'open'
    && prediction.n_neighbours >= 5
    && prediction.p_false_positive >= 0.4
    && prediction.p_false_positive <= 0.6;

  async function setStatus(newStatus: FindingStatus) {
    if (updating || newStatus === finding.status) return;
    setUpdating(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const update = {
      status: newStatus,
      triaged_by: newStatus === 'open' ? null : user?.id ?? null,
      triaged_at: newStatus === 'open' ? null : new Date().toISOString(),
    };
    const { error, data } = await supabase
      .from('findings')
      .update(update)
      .eq('id', finding.id)
      .select()
      .single();
    setUpdating(false);
    // Preserve joined fields (last_seen_scan, finding_occurrences) — the
    // .select() above only returns columns from the `findings` table.
    if (!error && data) {
      setFinding((prev) => ({ ...prev, ...(data as Finding) }));
    }
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-900/30 transition-all hover:border-neutral-700/80 hover:bg-neutral-900/50 ${
        muted ? 'opacity-60' : ''
      }`}
    >
      {/* The single severity signal — a thin gradient band on the left edge. */}
      <div className={`absolute inset-y-0 left-0 w-[3px] ${sev.band}`} aria-hidden />

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full px-6 py-5 pl-7 text-left"
      >
        <div className="flex items-start gap-4">
          {/* Severity icon disc — small, peripheral. Same colour as the band. */}
          <div
            className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-white/5 ${sev.iconBg}`}
            aria-label={`${sev.label} severity`}
          >
            <SevIcon className={`h-3.5 w-3.5 ${sev.iconColor}`} strokeWidth={2.25} />
          </div>

          <div className="min-w-0 flex-1">
            {/* Row 1: title (hero) + urgency pill on the right. */}
            <div className="flex items-start justify-between gap-3">
              <h3
                className={`text-[15px] font-semibold leading-snug sm:text-base ${
                  isResolved ? 'text-neutral-300 line-through decoration-neutral-700' : 'text-neutral-50'
                }`}
              >
                <span className="line-clamp-2">{finding.title}</span>
              </h3>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                {urgencyTheme && (() => {
                  const UIcon = urgencyTheme.Icon;
                  return (
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${urgencyTheme.pill}`}
                      title={urgencyTheme.intent}
                    >
                      <UIcon className="h-3 w-3" strokeWidth={2.5} />
                      {urgencyTheme.label}
                    </span>
                  );
                })()}
                <ChevronDown
                  className={`h-4 w-4 text-neutral-500 transition-transform duration-200 ${
                    expanded ? 'rotate-180 text-neutral-300' : ''
                  }`}
                  strokeWidth={2}
                />
              </div>
            </div>

            {/* Row 2: target / endpoint as a single mono line. Subdued. */}
            {(finding.endpoint || finding.target) && (
              <p className="mt-1 truncate font-mono text-[11.5px] text-neutral-500">
                {finding.endpoint
                  ? [finding.method, finding.endpoint].filter(Boolean).join(' ')
                  : finding.target}
              </p>
            )}

            {/* Row 3: AI one-liner — the *why*. Visible by default with a small
                gradient mark to keep the AI brand cue without a heavy banner. */}
            {aiOneLiner && (
              <div className="mt-2.5 flex items-start gap-2">
                <Sparkles
                  className={`mt-0.5 h-3 w-3 flex-shrink-0 ${ai ? AI_BRAND.iconColor : 'text-neutral-500'}`}
                  strokeWidth={2.25}
                />
                <p className="line-clamp-2 text-[13px] leading-relaxed text-neutral-300">
                  {aiOneLiner}
                </p>
              </div>
            )}

            {/* Row 4: subdued status + cross-scan recurrence indicators.
                Open status is implied — we don't badge it. The recurrence
                pill is the calm signal that this finding has cross-scan
                history; full timeline is in the expanded view. */}
            {(finding.status !== 'open' || isRecurring) && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {finding.status !== 'open' && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusTheme.pill}`}
                  >
                    <StatusIcon className="h-3 w-3" strokeWidth={2.5} />
                    {statusTheme.label}
                  </span>
                )}
                {reopenedCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30"
                    title="Marked fixed, but re-detected by a later scan."
                  >
                    <RefreshCw className="h-3 w-3" strokeWidth={2.5} />
                    Reopened{reopenedCount > 1 ? ` ${reopenedCount}×` : ''}
                  </span>
                )}
                {occurrenceCount > 1 && reopenedCount === 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-md bg-neutral-800/80 px-2 py-0.5 text-[10px] font-medium text-neutral-400 ring-1 ring-neutral-700/60"
                    title="Detected across multiple scans"
                  >
                    <Repeat className="h-3 w-3" strokeWidth={2.25} />
                    {occurrenceCount} scans
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="space-y-6 border-t border-neutral-800/60 bg-neutral-950/40 px-6 py-6 pl-7">
          {/* AI auto-dismissal banner. The user must always be able to find
              what the model hid and override it in one click — that's the
              non-negotiable reversibility property. We prefer this banner
              right at the top so the policy decision is unmistakable. */}
          {finding.status === 'dismissed_by_ai' && finding.auto_dismiss_reason && (
            <section className={`rounded-lg p-4 ${AI_BRAND.bgTint} ${AI_BRAND.ring}`}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-neutral-950/60 ring-1 ring-white/5">
                  <Brain className={`h-3.5 w-3.5 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
                      AI auto-dismissed
                    </span>
                    <span className="text-[10.5px] text-neutral-500">
                      {Math.round(finding.auto_dismiss_reason.p_false_positive * 100)}%
                      confidence · {finding.auto_dismiss_reason.n_neighbours} similar
                      decisions
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-neutral-200">
                    Your team has dismissed this kind of finding before with high
                    consistency, so we hid it for you. You can override if this one's
                    different.
                  </p>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setStatus('open')}
                      disabled={updating}
                      className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} />
                      Restore — this isn't a false positive
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* "Likely false positive" suggestion: the model is fairly sure but
              not auto-dismiss-sure (0.70–0.95 band). Surface to the user;
              either button writes a triage_signal — that's the active-
              learning loop closing. */}
          {showFpSuggestion && prediction && (
            <section className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/15 ring-1 ring-amber-400/30">
                  <Brain className="h-3.5 w-3.5 text-amber-200" strokeWidth={2.25} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-relaxed text-neutral-200">
                    <span className="font-medium text-amber-200">Likely false positive.</span>{' '}
                    Based on {prediction.n_neighbours} similar findings — {Math.round(prediction.p_false_positive * 100)}% have been dismissed by your team.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setStatus('false_positive')}
                      disabled={updating}
                      className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 ring-1 ring-zinc-700 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" strokeWidth={2.25} />
                      Confirm — false positive
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatus('triaged_real')}
                      disabled={updating}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/30 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Eye className="h-3.5 w-3.5" strokeWidth={2.25} />
                      Override — it's real
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Active learning hint. The 0.4–0.6 confidence band is exactly
              where each user click yields the most information for the
              model. We don't add action buttons — the existing triage row
              does the work — just signal that this one is high-value
              feedback. */}
          {showActiveLearningHint && prediction && (
            <section className="rounded-lg border border-violet-500/20 bg-violet-500/[0.03] p-3">
              <div className="flex items-start gap-2.5">
                <Brain className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-300" strokeWidth={2.25} />
                <p className="text-[12px] leading-relaxed text-neutral-300">
                  <span className={`font-medium ${AI_BRAND.gradientText}`}>
                    We're not sure about this one.
                  </span>{' '}
                  Your team's decisions on the {prediction.n_neighbours} most-similar findings
                  split roughly evenly. Your call here helps us learn.
                </p>
              </div>
            </section>
          )}

          {/* Compact metadata strip — the small facts that aren't worth a row
              in the collapsed view but still matter when you're looking. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-neutral-500">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${sev.iconBg.replace('/15', '/80')}`} />
              <span className="text-neutral-400">{sev.label}</span>
            </span>
            {/* Engine signals (migration 024). Verification status + confidence
                are the headline trust signals from PR #137; render them prominently. */}
            {finding.verification_status && (
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ring-1 ${
                  finding.verification_status === 'verified'
                    ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30'
                    : finding.verification_status === 'pattern_match'
                    ? 'bg-amber-500/10 text-amber-200 ring-amber-400/30'
                    : 'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40'
                }`}
                title="Engine verification — verified means the agent ran the exploit and confirmed; pattern_match is signature-only (PR #137)."
              >
                {finding.verification_status.replace(/_/g, ' ')}
              </span>
            )}
            {finding.confidence != null && (
              <span
                className="inline-flex items-center gap-1.5"
                title="Engine confidence (PR #137)."
              >
                <span className="text-neutral-600">conf</span>
                <span
                  className={`font-mono ${
                    finding.confidence >= 0.8
                      ? 'text-emerald-300'
                      : finding.confidence >= 0.5
                      ? 'text-amber-300'
                      : 'text-neutral-500'
                  }`}
                >
                  {finding.confidence.toFixed(2)}
                </span>
              </span>
            )}
            {finding.category && (() => {
              const cat = getCategoryTheme(finding.category);
              const CatIcon = cat.Icon;
              return (
                <span
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${cat.pill}`}
                  title={`Engine category: ${finding.category}`}
                >
                  <CatIcon className="h-3 w-3" strokeWidth={2.5} />
                  {cat.label}
                </span>
              );
            })()}
            {finding.cvss != null && (
              <span className="font-mono">
                <span className="text-neutral-600">CVSS</span>{' '}
                <span className="text-neutral-300">{finding.cvss}</span>
              </span>
            )}
            {finding.cwe && (
              <span className="font-mono text-neutral-400">{finding.cwe}</span>
            )}
            {finding.target && (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-neutral-600">target</span>
                <code className="rounded bg-neutral-900/80 px-1.5 py-0.5 font-mono text-cyan-300/90 ring-1 ring-neutral-800">
                  {finding.target}
                </code>
              </span>
            )}
            {prediction && prediction.n_neighbours > 0 && (
              <span
                className="inline-flex items-center gap-1.5"
                title={`Based on ${prediction.n_neighbours} similar finding${prediction.n_neighbours === 1 ? '' : 's'} (vector similarity over your org's prior triage decisions). Mean similarity ${prediction.mean_similarity.toFixed(2)}.`}
              >
                <Brain className={`h-3 w-3 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
                <span className="text-neutral-400">
                  AI: {Math.round(prediction.p_false_positive * 100)}% likely FP
                </span>
                <span className="text-neutral-600">
                  · n={prediction.n_neighbours}
                </span>
              </span>
            )}
          </div>

          {/* Engine reasoning trace (PR #137). The "why we believe this is
              exploitable" bullets — the single biggest "is this AI talking to
              me, or guessing?" tell. Up to 20 × 320 chars per bullet. */}
          {finding.reasoning_trace && finding.reasoning_trace.length > 0 && (
            <section className="rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <Brain className={`h-3.5 w-3.5 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
                <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
                  Why we believe this is exploitable
                </h4>
              </div>
              <ul className="space-y-1.5">
                {finding.reasoning_trace.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-neutral-200">
                    <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-cyan-400" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Counter-proof block (PR #137). The auditor-grade "we considered
              this might not be a real finding" signal. Increases trust
              massively when present. */}
          {finding.counter_proof && (finding.counter_proof.description || finding.counter_proof.evidence) && (
            <section className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-4">
              <div className="mb-2 flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 text-amber-300" strokeWidth={2.25} />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-amber-200">
                  Possible alternative explanation
                </h4>
              </div>
              {finding.counter_proof.description && (
                <p className="text-[12.5px] leading-relaxed text-neutral-200">
                  {finding.counter_proof.description}
                </p>
              )}
              {finding.counter_proof.evidence && (
                <pre className="mt-2 overflow-x-auto rounded bg-neutral-950/60 p-2 text-[11px] text-neutral-300 ring-1 ring-neutral-800">
                  {finding.counter_proof.evidence}
                </pre>
              )}
            </section>
          )}

          {/* Cross-scan history. The ledger (finding_occurrences) is the source
              of truth; we show the lifespan as a vertical timeline so the
              "first" and "last" reads top-to-bottom like a log. Hidden when
              there's only one occurrence — irrelevant noise in that case. */}
          {isRecurring && occurrences.length > 0 && (
            <section className="rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-neutral-500" strokeWidth={2.25} />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Cross-scan history
                </h4>
                <span className="text-[10.5px] text-neutral-500">
                  {occurrenceCount === 1
                    ? '1 detection'
                    : `${occurrenceCount} detections across ${occurrenceCount} scans`}
                </span>
              </div>
              <ol className="space-y-1.5">
                {occurrences.map((occ, idx) => {
                  const isFirst = idx === 0;
                  const isLast = idx === occurrences.length - 1;
                  const date = new Date(occ.seen_at);
                  return (
                    <li
                      key={occ.scan_id + occ.seen_at}
                      className="flex items-start gap-2.5 text-[12px] leading-relaxed"
                    >
                      <span
                        className={`mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                          occ.reopened
                            ? 'bg-amber-400'
                            : isLast
                            ? 'bg-cyan-400'
                            : 'bg-neutral-600'
                        }`}
                      />
                      <span className="font-mono text-[11px] text-neutral-500">
                        {date.toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <Link
                        href={`/scans/${occ.scan_id}`}
                        className="truncate font-medium text-neutral-300 transition-colors hover:text-cyan-300"
                      >
                        {occ.scans?.run_name ?? 'unnamed scan'}
                      </Link>
                      {isFirst && (
                        <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-400">
                          first
                        </span>
                      )}
                      {isLast && !isFirst && (
                        <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300 ring-1 ring-cyan-500/20">
                          latest
                        </span>
                      )}
                      {occ.reopened && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200 ring-1 ring-amber-400/30"
                          title="This detection flipped the finding back from 'fixed' to active."
                        >
                          <RefreshCw className="h-2.5 w-2.5" strokeWidth={2.5} />
                          reopened
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              {reopenedCount > 0 && (
                <p className="mt-3 text-[11px] leading-relaxed text-amber-200/80">
                  This finding was marked fixed and re-detected{' '}
                  {reopenedCount === 1 ? 'once' : `${reopenedCount} times`}. Verify the fix
                  actually addresses the root cause.
                </p>
              )}
            </section>
          )}

          {/* Cross-finding triage history. Shows how this org has decided on
              similar findings before (same CWE + target). The system
              "remembers" — clicks aren't lost. Phase 1 of the per-tenant
              triage learning loop; phase 2 will replace the SQL aggregation
              with a vector-similarity model but the UI shape stays the same. */}
          {triageHistory && triageHistory.total > 0 && (
            <section className="rounded-lg border border-violet-500/15 bg-violet-500/[0.04] p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <Brain className="h-3.5 w-3.5 text-violet-300" strokeWidth={2.25} />
                <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
                  Your team's pattern
                </h4>
                <span className="text-[10.5px] text-neutral-500">
                  {triageHistory.total} similar finding{triageHistory.total === 1 ? '' : 's'} triaged before
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <TriageStat
                  count={triageHistory.false_positive}
                  label="False positive"
                  tone="zinc"
                />
                <TriageStat
                  count={triageHistory.wont_fix}
                  label="Won't fix"
                  tone="zinc"
                />
                <TriageStat
                  count={triageHistory.triaged_real}
                  label="Confirmed real"
                  tone="amber"
                />
                <TriageStat count={triageHistory.fixed} label="Fixed" tone="emerald" />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-neutral-400">
                {(() => {
                  const dismissed = triageHistory.false_positive + triageHistory.wont_fix;
                  const real = triageHistory.triaged_real + triageHistory.fixed;
                  if (dismissed > real * 2) {
                    return `Most similar findings were dismissed. Lean toward false-positive unless you can verify exploitability.`;
                  }
                  if (real > dismissed * 2) {
                    return `Most similar findings were confirmed real. Treat this seriously.`;
                  }
                  return `Mixed history — your team's call could go either way.`;
                })()}
              </p>
            </section>
          )}

          {ai && urgencyTheme && reachTheme && (() => {
            const UIcon = urgencyTheme.Icon;
            const RIcon = reachTheme.Icon;
            return (
              <section className={`rounded-lg p-4 ${AI_BRAND.bgTint} ${AI_BRAND.ring}`}>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-neutral-950/60 ring-1 ring-white/5">
                    <Sparkles className={`h-3.5 w-3.5 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
                        AI assessment
                      </span>
                      <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${urgencyTheme.pill}`}>
                        <UIcon className="h-3 w-3" strokeWidth={2.5} />
                        {urgencyTheme.label}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-[11px] ${reachTheme.color}`}>
                        <RIcon className="h-3 w-3" strokeWidth={2.5} />
                        {reachTheme.label}
                      </span>
                      <span className="text-[10.5px] text-neutral-500">
                        confidence {Math.round(ai.confidence * 100)}%
                      </span>
                      {ai.is_likely_false_positive && (
                        <span className="rounded-md bg-zinc-700/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-zinc-300 ring-1 ring-zinc-600/40">
                          likely FP
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-neutral-200">
                      {ai.reasoning}
                    </p>
                    {ai.recommended_action && (
                      <p className="mt-2 text-[12.5px] text-neutral-400">
                        <span className="font-medium text-neutral-300">Recommended:</span>{' '}
                        {ai.recommended_action}
                      </p>
                    )}
                    <p className="mt-2 text-[10px] text-neutral-600">
                      Assessed by {ai.model ?? 'LLM'}
                      {finding.ai_assessed_at &&
                        ` · ${new Date(finding.ai_assessed_at).toLocaleString()}`}
                    </p>
                  </div>
                </div>
              </section>
            );
          })()}

          {/* Heuristic kill-chain — pillar 1 item 2. Tells the story of how
              the agent reached this finding step by step (browsed page →
              tried payload → got reflection → confirmed). Approximate by
              construction: same-scan events in the 5-minute window before
              `finding.created`, optionally filtered to the agent that
              filed the report. Hidden when the RPC returns no steps. */}
          {/* Engine's deterministic kill chain (PR #36 / migration 024).
              The 7-value `type` enum tells us exactly what each step
              accomplished — no heuristic needed. Fall back to the
              wrapper-side time-window heuristic when the engine didn't
              attach a chain (single-step pattern matches). */}
          {engineKillChain && engineKillChain.chain && engineKillChain.chain.length > 0 ? (
            <EngineKillChainSection chain={engineKillChain} />
          ) : killChain && killChain.steps.length > 0 ? (
            <KillChainSection chain={killChain} />
          ) : null}

          {sections.length === 0 && finding.description_md && (
            <Markdown body={finding.description_md} />
          )}

          {sections.map((s) => (
            <section key={s.heading} className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300/80">
                {s.friendly}
              </h4>
              <Markdown body={s.body} />
            </section>
          ))}

          {/* Triage controls */}
          <section className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Triage
              </h4>
              {updating && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" strokeWidth={2.5} />
              )}
            </div>
            <p className="text-xs text-neutral-500">
              Mark this finding so future scans and the dashboard reflect its real state.
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <TriageButton
                onClick={() => setStatus('fixed')}
                active={finding.status === 'fixed'}
                tone="emerald"
                Icon={CheckCircle2}
                disabled={updating}
              >
                Fixed
              </TriageButton>
              <TriageButton
                onClick={() => setStatus('triaged_real')}
                active={finding.status === 'triaged_real'}
                tone="amber"
                Icon={Eye}
                disabled={updating}
              >
                Confirmed real
              </TriageButton>
              <TriageButton
                onClick={() => setStatus('false_positive')}
                active={finding.status === 'false_positive'}
                tone="neutral"
                Icon={XCircle}
                disabled={updating}
              >
                False positive
              </TriageButton>
              <TriageButton
                onClick={() => setStatus('wont_fix')}
                active={finding.status === 'wont_fix'}
                tone="neutral"
                Icon={XCircle}
                disabled={updating}
              >
                Won't fix
              </TriageButton>
              {finding.status !== 'open' && (
                <TriageButton
                  onClick={() => setStatus('open')}
                  active={false}
                  tone="blue"
                  Icon={RotateCcw}
                  disabled={updating}
                >
                  Reopen
                </TriageButton>
              )}
            </div>
            {finding.triaged_at && finding.status !== 'open' && (
              <div className="pt-1.5 text-[10.5px] text-neutral-500">
                Triaged {new Date(finding.triaged_at).toLocaleString()}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

const TONE_BUTTON: Record<string, { active: string; idle: string }> = {
  emerald: {
    active: 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40',
    idle: 'bg-neutral-900 text-neutral-300 ring-1 ring-neutral-800 hover:bg-emerald-500/10 hover:text-emerald-200 hover:ring-emerald-400/30',
  },
  amber: {
    active: 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40',
    idle: 'bg-neutral-900 text-neutral-300 ring-1 ring-neutral-800 hover:bg-amber-500/10 hover:text-amber-200 hover:ring-amber-400/30',
  },
  neutral: {
    active: 'bg-neutral-700/60 text-neutral-200 ring-1 ring-neutral-600/40',
    idle: 'bg-neutral-900 text-neutral-300 ring-1 ring-neutral-800 hover:bg-neutral-800 hover:text-neutral-100',
  },
  blue: {
    active: 'bg-blue-500/20 text-blue-200 ring-1 ring-blue-400/40',
    idle: 'bg-neutral-900 text-neutral-300 ring-1 ring-neutral-800 hover:bg-blue-500/10 hover:text-blue-200 hover:ring-blue-400/30',
  },
};

function TriageButton({
  onClick,
  active,
  tone,
  Icon,
  disabled,
  children,
}: {
  onClick: () => void;
  active: boolean;
  tone: keyof typeof TONE_BUTTON;
  Icon: typeof CheckCircle2;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const t = TONE_BUTTON[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? t.active : t.idle
      }`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      {children}
    </button>
  );
}

const STAT_TONE: Record<string, string> = {
  zinc: 'text-neutral-400',
  amber: 'text-amber-300',
  emerald: 'text-emerald-300',
};

function TriageStat({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: keyof typeof STAT_TONE;
}) {
  const t = STAT_TONE[tone];
  const dim = count === 0;
  return (
    <div className="rounded-md bg-neutral-900/60 px-2.5 py-2 ring-1 ring-neutral-800/80">
      <div className={`text-lg font-semibold tracking-tight ${dim ? 'text-neutral-700' : t}`}>
        {count}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill-chain section — pillar 1 item 2.
//
// Renders the chronological timeline of agent actions in the 5-minute
// window before this finding was filed. The data is best-effort (see the
// `kill_chain_for_finding` RPC docs); the UI surface labels it as
// "approximate timeline" so users don't read deterministic kill-chain
// reconstruction into a heuristic grouping.
// ---------------------------------------------------------------------------

const KILL_CHAIN_TOOL_LABELS: Record<string, string> = {
  agent_finish: 'Wrapped up',
  browser_navigate: 'Browsed',
  browser_click: 'Clicked',
  browser_fill: 'Filled a form',
  browser_screenshot: 'Captured screenshot',
  browser_javascript: 'Ran JavaScript',
  http_request: 'Sent HTTP request',
  terminal_execute: 'Ran shell command',
  file_read: 'Read source',
  file_write: 'Wrote file',
  file_edit: 'Edited file',
  file_search: 'Searched code',
  file_grep: 'Searched code',
  proxy_inspect: 'Inspected traffic',
  proxy_replay: 'Replayed request',
  notes_write: 'Took notes',
  create_subagent: 'Spawned sub-agent',
  create_vulnerability_report: 'Filed report',
};

function killChainStepLabel(step: KillChainStep): {
  label: string;
  surface: string | null;
} {
  const payload = (step.payload as Record<string, unknown> | null) ?? {};
  if (step.event_type === 'chat.message') {
    // chat.message is the LLM's reasoning between actions. Surface a
    // short snippet so users see the *thinking* between tool calls.
    const inner = (payload.payload as Record<string, unknown> | undefined) ?? {};
    const text =
      (inner.content as string | undefined) ??
      (payload.content as string | undefined) ??
      (payload.message as string | undefined) ??
      '';
    const trimmed = (text || '').trim().replace(/\s+/g, ' ');
    return {
      label: 'Reasoning',
      surface: trimmed ? (trimmed.length > 140 ? trimmed.slice(0, 140) + '…' : trimmed) : null,
    };
  }
  // tool.execution.started — pull tool_name + a useful surface field.
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? {};
  const actor = (payload.actor as Record<string, unknown> | undefined) ?? {};
  const toolName =
    (actor.tool_name as string | undefined) ??
    (inner.tool_name as string | undefined) ??
    'unknown tool';
  const args = (inner.args as Record<string, unknown> | undefined) ?? {};
  let surface: string | null = null;
  for (const k of ['url', 'endpoint', 'target', 'path', 'command', 'pattern']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) {
      surface = v.length > 200 ? v.slice(0, 200) + '…' : v;
      break;
    }
  }
  return {
    label: KILL_CHAIN_TOOL_LABELS[toolName] ?? toolName,
    surface,
  };
}

// ---------------------------------------------------------------------------
// Engine-deterministic kill chain (engine PR #36; lives on findings.kill_chain
// JSONB after migration 024 + PR #42 ingest). Renders the structured
// `chain[]` with per-step type-icon mapping. Distinct from the heuristic
// `KillChainSection` below (which assembles a fuzzy timeline from scan_events
// when the engine didn't attach a structured chain).
// ---------------------------------------------------------------------------

const ENGINE_KILL_CHAIN_TYPE: Record<
  KillChainStepEngine['type'],
  { label: string; dot: string; icon: string }
> = {
  recon:             { label: 'Recon',             dot: 'bg-cyan-400',    icon: '🔍' },
  discovery:         { label: 'Discovery',         dot: 'bg-blue-400',    icon: '📋' },
  exploitation:      { label: 'Exploitation',      dot: 'bg-orange-400',  icon: '💥' },
  escalation:        { label: 'Escalation',        dot: 'bg-rose-400',    icon: '🔐' },
  lateral_movement:  { label: 'Lateral movement',  dot: 'bg-rose-400',    icon: '🔀' },
  impact:            { label: 'Impact',            dot: 'bg-rose-500',    icon: '☠️' },
  validation:        { label: 'Validation',        dot: 'bg-emerald-400', icon: '✓' },
};

function EngineKillChainSection({ chain }: { chain: { step_count?: number; chain?: KillChainStepEngine[] } }) {
  const steps = chain.chain ?? [];
  return (
    <section className="rounded-lg border border-violet-500/15 bg-violet-500/[0.03] p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Footprints className="h-3.5 w-3.5 text-violet-300" strokeWidth={2.25} />
        <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
          How the agent reached this
        </h4>
        <span
          className="text-[10.5px] text-neutral-500"
          title="Engine-emitted deterministic kill chain (PR #36)."
        >
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
      </div>
      <ol className="space-y-2.5">
        {steps.map((step, i) => {
          const meta = ENGINE_KILL_CHAIN_TYPE[step.type] ?? {
            label: step.type, dot: 'bg-neutral-500', icon: '·',
          };
          return (
            <li key={`${step.step_number}-${i}`} className="flex items-start gap-3">
              <span className="mt-0.5 inline-block w-5 flex-shrink-0 text-right font-mono text-[11px] text-neutral-600">
                {step.step_number}.
              </span>
              <span className={`mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${meta.dot}`} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] leading-relaxed">
                  <span className="text-[10.5px] font-medium uppercase tracking-wider text-violet-200">
                    {meta.label}
                  </span>
                  <span className="text-neutral-200">{step.description}</span>
                </div>
                {(step.tool || step.evidence) && (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-neutral-500">
                    {step.tool && <span className="font-mono text-amber-300/80">{step.tool}</span>}
                    {step.evidence && (
                      <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">
                        {step.evidence}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function KillChainSection({ chain }: { chain: KillChainResponse }) {
  return (
    <section className="rounded-lg border border-violet-500/15 bg-violet-500/[0.03] p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Footprints className="h-3.5 w-3.5 text-violet-300" strokeWidth={2.25} />
        <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
          How the agent reached this
        </h4>
        <span
          className="text-[10.5px] text-neutral-500"
          title="Approximate timeline. Reconstructed from scan events in the 5-minute window before the finding was filed; same-agent filtering when the upstream attribution is present."
        >
          {chain.steps.length} step{chain.steps.length === 1 ? '' : 's'} · approximate
        </span>
      </div>
      <ol className="space-y-2">
        {chain.steps.map((step, i) => {
          const { label, surface } = killChainStepLabel(step);
          const isReasoning = step.event_type === 'chat.message';
          return (
            <li key={`${step.created_at}-${i}`} className="flex items-start gap-3">
              <span className="mt-0.5 inline-block w-5 flex-shrink-0 text-right font-mono text-[11px] text-neutral-600">
                {i + 1}.
              </span>
              <span
                className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  isReasoning ? 'bg-violet-400' : 'bg-cyan-400'
                }`}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className={isReasoning ? 'italic text-violet-200' : 'font-medium text-amber-300/90'}>
                    {label}
                  </span>
                  {surface && (
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
                        isReasoning ? 'text-neutral-400' : 'text-neutral-300'
                      }`}
                    >
                      {surface}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Markdown({ body }: { body: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-neutral-200 prose-headings:text-neutral-100 prose-p:leading-relaxed prose-p:text-neutral-300 prose-a:font-medium prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline prose-strong:text-neutral-100 prose-code:rounded prose-code:bg-neutral-900 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12.5px] prose-code:font-medium prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-neutral-950 prose-pre:p-3 prose-pre:text-[12px] prose-li:my-0.5 prose-li:text-neutral-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
