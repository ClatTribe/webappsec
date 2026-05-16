'use client';

import { useState } from 'react';
import {
  FileLock,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Circle,
  HelpCircle,
  Loader2,
  Copy,
  FileText,
} from 'lucide-react';

interface Template {
  key: string;
  framework: string;
  question_count: number;
}

interface Evidence {
  control_id: string;
  verdict: 'pass' | 'fail' | 'warn' | 'untested' | 'info';
  summary: string | null;
  observed_at: string | null;
  // Engine-emitted freshness fields (strix PR #252). The engine stamps
  // `expires_at = evidence_collected_at + STRIX_EVIDENCE_TTL_DAYS` (90 by
  // default). Both arrive through compliance_evidence.detail.* on the
  // ingest path and are surfaced by the questionnaire API alongside the
  // evidence summary.
  evidence_collected_at?: string | null;
  expires_at?: string | null;
}

interface Answer {
  pos: number;
  section: string | null;
  question_id: string;
  question: string;
  note: string | null;
  control_ids: string[];
  answer_status: 'pass' | 'fail' | 'warn' | 'partial' | 'untested';
  evidence: Evidence[];
}

const TEMPLATE_LABELS: Record<string, string> = {
  soc2_saq_v1: 'SOC 2 Trust Services SAQ',
  // Engine PR #253 / migration 059 — HIPAA Security Rule SAQ. 10 questions
  // across Administrative / Physical / Technical safeguards keyed by 45
  // CFR § 164.30x control identifiers.
  hipaa_saq_v1: 'HIPAA Security Rule SAQ',
  sig_lite_v1: 'SIG Lite (Standardized Information Gathering)',
  caiq_v4: 'Cloud Security Alliance CAIQ v4',
  vsa_v1: 'Vendor Security Assessment (VSA)',
};

const STATUS_THEME: Record<Answer['answer_status'], { label: string; bg: string; text: string; icon: typeof CheckCircle2 }> = {
  pass:     { label: 'Yes',     bg: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30', text: 'text-emerald-300', icon: CheckCircle2 },
  fail:     { label: 'No',      bg: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',           text: 'text-rose-300',    icon: XCircle },
  warn:     { label: 'Partial', bg: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',         text: 'text-amber-300',   icon: AlertTriangle },
  partial:  { label: 'Partial', bg: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',         text: 'text-amber-300',   icon: AlertTriangle },
  untested: { label: 'Not yet', bg: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',   text: 'text-neutral-300', icon: Circle },
};

export default function QuestionnaireClient({ templates }: { templates: Template[] }) {
  const [activeKey, setActiveKey] = useState<string | null>(templates[0]?.key ?? null);
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadQuestionnaire(key: string) {
    setLoading(true);
    setError(null);
    setAnswers(null);
    setActiveKey(key);
    try {
      const res = await fetch(`/api/compliance/questionnaire?key=${encodeURIComponent(key)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'failed to load');
        return;
      }
      const data = (await res.json()) as { answers: Answer[] };
      setAnswers(data.answers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!answers || !activeKey) return;
    const rows = [
      ['Section', 'Question ID', 'Question', 'Answer', 'Notes', 'Evidence'],
      ...answers.map((a) => [
        a.section ?? '',
        a.question_id,
        a.question,
        STATUS_THEME[a.answer_status].label,
        a.note ?? '',
        a.evidence.map((e) => `${e.control_id}: ${e.verdict}${e.summary ? ` (${e.summary})` : ''}`).join(' · '),
      ]),
    ];
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    downloadBlob(csv, `tensorshield-${activeKey}.csv`, 'text/csv');
  }

  function exportJson() {
    if (!answers || !activeKey) return;
    downloadBlob(
      JSON.stringify({ key: activeKey, generated_at: new Date().toISOString(), answers }, null, 2),
      `tensorshield-${activeKey}.json`,
      'application/json',
    );
  }

  async function copyMarkdown() {
    if (!answers) return;
    const md =
      answers
        .map((a) => {
          const status = STATUS_THEME[a.answer_status].label;
          return `### ${a.question_id} — ${a.question}\n\n**Answer:** ${status}\n\n${
            a.evidence.length
              ? a.evidence
                  .map((e) => `- \`${e.control_id}\` (${e.verdict})${e.summary ? `: ${e.summary}` : ''}`)
                  .join('\n')
              : ''
          }${a.note ? `\n\n_${a.note}_` : ''}\n`;
        })
        .join('\n');
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      // best-effort
    }
  }

  // Group answers by section for the rendered table.
  const grouped = (answers ?? []).reduce<Record<string, Answer[]>>((acc, a) => {
    const key = a.section ?? 'Other';
    (acc[key] = acc[key] ?? []).push(a);
    return acc;
  }, {});

  // Summary counts.
  const totals = (answers ?? []).reduce(
    (acc, a) => {
      acc[a.answer_status] = (acc[a.answer_status] ?? 0) + 1;
      return acc;
    },
    {} as Record<Answer['answer_status'], number>,
  );

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
          <FileLock className="h-3 w-3" strokeWidth={2.5} />
          Compliance questionnaires
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Pre-filled answers for your prospect&apos;s assessment.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-neutral-400">
          Pick a questionnaire. TensorShield maps each question to your compliance evidence
          verdicts and fills in the answer. Export to CSV / JSON, or copy as markdown, and paste
          into the prospect&apos;s spreadsheet.
        </p>
      </header>

      {/* Template picker */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Available templates
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {templates.length === 0 ? (
            <p className="text-sm text-neutral-500">No questionnaire templates seeded yet.</p>
          ) : (
            templates.map((t) => (
              <button
                key={t.key}
                onClick={() => loadQuestionnaire(t.key)}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  activeKey === t.key
                    ? 'border-cyan-500/40 bg-cyan-500/10'
                    : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700'
                }`}
              >
                <div className="text-sm font-medium text-neutral-100">
                  {TEMPLATE_LABELS[t.key] ?? t.key}
                </div>
                <div className="mt-1 text-[11px] text-neutral-500">
                  {t.framework} · {t.question_count} questions
                </div>
              </button>
            ))
          )}
        </div>
      </section>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Generating answers from your scan history…
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {answers && answers.length > 0 && (
        <>
          {/* Summary + export bar */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-300">
                <span>
                  <strong className="text-emerald-300">{totals.pass ?? 0}</strong> pass
                </span>
                <span className="text-neutral-700">·</span>
                <span>
                  <strong className="text-amber-300">{(totals.warn ?? 0) + (totals.partial ?? 0)}</strong>{' '}
                  partial
                </span>
                <span className="text-neutral-700">·</span>
                <span>
                  <strong className="text-rose-300">{totals.fail ?? 0}</strong> no
                </span>
                <span className="text-neutral-700">·</span>
                <span>
                  <strong className="text-neutral-300">{totals.untested ?? 0}</strong> not yet
                </span>
                <span className="text-neutral-700">·</span>
                <span>{answers.length} total</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={copyMarkdown}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
                >
                  <Copy className="h-3 w-3" strokeWidth={2.5} />
                  Copy as Markdown
                </button>
                <button
                  onClick={exportJson}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
                >
                  <FileText className="h-3 w-3" strokeWidth={2.5} />
                  JSON
                </button>
                <button
                  onClick={exportCsv}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
                >
                  <Download className="h-3 w-3" strokeWidth={2.5} />
                  Export CSV
                </button>
              </div>
            </div>
          </section>

          {/* Sectioned table */}
          {Object.entries(grouped).map(([section, rows]) => (
            <section key={section} className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                {section}
              </h3>
              <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
                {rows.map((a) => {
                  const theme = STATUS_THEME[a.answer_status];
                  const Icon = theme.icon;
                  return (
                    <div
                      key={a.question_id}
                      className="grid grid-cols-[auto_1fr_auto] items-start gap-4 border-b border-neutral-800/60 px-4 py-4 last:border-b-0"
                    >
                      <div className="flex-shrink-0 pt-0.5">
                        <Icon className={`h-4 w-4 ${theme.text}`} strokeWidth={2.25} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
                            {a.question_id}
                          </code>
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${theme.bg}`}
                          >
                            {theme.label}
                          </span>
                          {a.control_ids.map((cid) => (
                            <code
                              key={cid}
                              className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-500"
                            >
                              {cid}
                            </code>
                          ))}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-neutral-100">
                          {a.question}
                        </p>
                        {a.evidence.length > 0 && (
                          <details className="mt-2 text-[11.5px]">
                            <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
                              Evidence ({a.evidence.length})
                            </summary>
                            <ul className="mt-2 space-y-1 pl-3">
                              {a.evidence.map((e) => {
                                const fresh = describeFreshness(e);
                                return (
                                  <li key={e.control_id} className="text-neutral-300">
                                    <code className="font-mono text-neutral-400">{e.control_id}</code>
                                    <span className={`ml-2 ${verdictColor(e.verdict)}`}>{e.verdict}</span>
                                    {e.summary && (
                                      <span className="ml-2 text-neutral-400">— {e.summary}</span>
                                    )}
                                    {fresh && (
                                      <FreshnessChip {...fresh} />
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </details>
                        )}
                        {a.note && (
                          <p className="mt-2 text-[11.5px] italic text-neutral-500">{a.note}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </>
      )}

      {answers && answers.length === 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-6 text-center">
          <HelpCircle className="mx-auto h-6 w-6 text-neutral-500" strokeWidth={2} />
          <p className="mt-3 text-sm text-neutral-300">
            No questions matched. The template might be empty or the controls don&apos;t exist in
            your evidence yet — run a scan and try again.
          </p>
        </div>
      )}
    </div>
  );
}

function verdictColor(v: string): string {
  if (v === 'pass') return 'text-emerald-300';
  if (v === 'fail') return 'text-rose-300';
  if (v === 'warn') return 'text-amber-300';
  return 'text-neutral-400';
}

// Engine PR #252 — auditor-grade evidence freshness. Strix stamps each
// control's `evidence_collected_at` + `expires_at` (collected_at +
// STRIX_EVIDENCE_TTL_DAYS, default 90). The wrapper trusts the engine's
// TTL rather than computing one — different frameworks may set
// different TTLs and that's the engine's call to make. We render three
// states:
//
//   - stale  → past expires_at, amber pill ("stale · 17 days past")
//   - fresh  → collected within the last 30 days, neutral pill
//                ("3 days ago")
//   - aging  → between fresh and stale, neutral pill ("47 days ago")
//
// Returns null when the engine didn't emit freshness fields (older
// strix versions pre-#252).
function describeFreshness(e: Evidence): { kind: 'stale' | 'aging' | 'fresh'; label: string } | null {
  // Prefer engine's authoritative collected_at; fall back to wrapper's
  // observed_at which is set to `now()` on the row insert.
  const collected = e.evidence_collected_at ?? e.observed_at;
  if (!collected) return null;
  const collectedMs = Date.parse(collected);
  if (!Number.isFinite(collectedMs)) return null;

  const now = Date.now();
  const ageDays = Math.max(0, Math.floor((now - collectedMs) / (24 * 60 * 60 * 1000)));

  if (e.expires_at) {
    const expiresMs = Date.parse(e.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs < now) {
      const pastDays = Math.max(1, Math.floor((now - expiresMs) / (24 * 60 * 60 * 1000)));
      return { kind: 'stale', label: `stale · ${pastDays}d past TTL` };
    }
  }

  if (ageDays < 30) {
    return { kind: 'fresh', label: ageDays === 0 ? 'today' : `${ageDays}d ago` };
  }
  return { kind: 'aging', label: `${ageDays}d ago` };
}

function FreshnessChip({ kind, label }: { kind: 'stale' | 'aging' | 'fresh'; label: string }) {
  const tone =
    kind === 'stale'
      ? 'bg-amber-500/15 text-amber-200 ring-amber-400/30'
      : kind === 'fresh'
        ? 'bg-emerald-500/10 text-emerald-300/80 ring-emerald-500/20'
        : 'bg-neutral-800/60 text-neutral-400 ring-neutral-700/60';
  return (
    <span
      className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${tone}`}
      title="Evidence age — engine emits evidence_collected_at + expires_at per control (strix PR #252)."
    >
      {label}
    </span>
  );
}

function csvEscape(cell: string): string {
  if (/[",\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
