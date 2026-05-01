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
} from 'lucide-react';
import type { Finding, FindingStatus, TriageHistory } from '@/lib/supabase/types';
import { createClient } from '@/lib/supabase/client';
import {
  AI_BRAND,
  REACHABILITY_THEME,
  SEVERITY_THEME,
  STATUS_THEME,
  URGENCY_THEME,
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
  useEffect(() => {
    if (!expanded || triageHistoryLoaded) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc('triage_history_for_finding', {
        p_finding_id: finding.id,
      });
      if (cancelled) return;
      setTriageHistory((data as TriageHistory | null) ?? null);
      setTriageHistoryLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, triageHistoryLoaded, finding.id]);

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
          {/* Compact metadata strip — the small facts that aren't worth a row
              in the collapsed view but still matter when you're looking. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-neutral-500">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${sev.iconBg.replace('/15', '/80')}`} />
              <span className="text-neutral-400">{sev.label}</span>
            </span>
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
          </div>

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

function Markdown({ body }: { body: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-neutral-200 prose-headings:text-neutral-100 prose-p:leading-relaxed prose-p:text-neutral-300 prose-a:font-medium prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline prose-strong:text-neutral-100 prose-code:rounded prose-code:bg-neutral-900 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12.5px] prose-code:font-medium prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-neutral-950 prose-pre:p-3 prose-pre:text-[12px] prose-li:my-0.5 prose-li:text-neutral-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
