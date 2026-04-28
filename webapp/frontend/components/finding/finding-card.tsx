'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown,
  AlertTriangle,
  Flame,
  AlertCircle,
  Info,
  CircleDot,
  CheckCircle2,
  XCircle,
  Eye,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import type { Finding, FindingStatus, Severity } from '@/lib/supabase/types';
import { createClient } from '@/lib/supabase/client';

const SEVERITY_THEME: Record<
  Severity,
  {
    Icon: typeof AlertTriangle;
    iconColor: string;
    cardBg: string;
    stripe: string;
    pill: string;
    tagline: string;
  }
> = {
  critical: {
    Icon: Flame,
    iconColor: 'text-red-300',
    cardBg: 'from-red-950/30 via-neutral-950/0 to-neutral-950/0',
    stripe: 'from-red-500 via-red-600 to-rose-700 text-red-500',
    pill: 'bg-red-600/15 text-red-200 ring-1 ring-red-500/30',
    tagline: 'Active threat — fix immediately.',
  },
  high: {
    Icon: AlertTriangle,
    iconColor: 'text-orange-300',
    cardBg: 'from-orange-950/25 via-neutral-950/0 to-neutral-950/0',
    stripe: 'from-orange-500 to-amber-600 text-orange-500',
    pill: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-400/30',
    tagline: 'Likely exploitable — fix soon.',
  },
  medium: {
    Icon: AlertCircle,
    iconColor: 'text-amber-300',
    cardBg: 'from-amber-950/20 via-neutral-950/0 to-neutral-950/0',
    stripe: 'from-yellow-500 to-amber-500 text-yellow-500',
    pill: 'bg-yellow-500/15 text-yellow-200 ring-1 ring-yellow-400/30',
    tagline: 'Possible risk — review and fix.',
  },
  low: {
    Icon: CircleDot,
    iconColor: 'text-lime-300',
    cardBg: 'from-emerald-950/15 via-neutral-950/0 to-neutral-950/0',
    stripe: 'from-lime-500 to-emerald-600 text-lime-500',
    pill: 'bg-lime-500/15 text-lime-200 ring-1 ring-lime-400/30',
    tagline: 'Minor concern — fix when convenient.',
  },
  info: {
    Icon: Info,
    iconColor: 'text-neutral-300',
    cardBg: 'from-neutral-900/40 via-neutral-950/0 to-neutral-950/0',
    stripe: 'from-neutral-500 to-neutral-600 text-neutral-500',
    pill: 'bg-neutral-700/40 text-neutral-200 ring-1 ring-neutral-600/40',
    tagline: 'Worth noting — not directly exploitable.',
  },
};

const STATUS_THEME: Record<
  FindingStatus,
  { label: string; pill: string; Icon: typeof CheckCircle2 }
> = {
  open: {
    label: 'Open',
    pill: 'bg-blue-500/10 text-blue-200 ring-1 ring-blue-400/30',
    Icon: AlertCircle,
  },
  triaged_real: {
    label: 'Triaged · real',
    pill: 'bg-amber-500/10 text-amber-200 ring-1 ring-amber-400/30',
    Icon: Eye,
  },
  fixed: {
    label: 'Fixed',
    pill: 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30',
    Icon: CheckCircle2,
  },
  false_positive: {
    label: 'False positive',
    pill: 'bg-neutral-700/50 text-neutral-300 ring-1 ring-neutral-600/40',
    Icon: XCircle,
  },
  wont_fix: {
    label: "Won't fix",
    pill: 'bg-neutral-700/50 text-neutral-300 ring-1 ring-neutral-600/40',
    Icon: XCircle,
  },
};

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

interface Props {
  finding: Finding;
  defaultExpanded?: boolean;
}

export default function FindingCard({ finding: initial, defaultExpanded = false }: Props) {
  const [finding, setFinding] = useState<Finding>(initial);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [updating, setUpdating] = useState(false);

  const theme = SEVERITY_THEME[finding.severity];
  const statusTheme = STATUS_THEME[finding.status];
  const { summary, sections } = parseFindingMarkdown(finding.description_md);
  const Icon = theme.Icon;
  const StatusIcon = statusTheme.Icon;
  const isResolved =
    finding.status === 'fixed' ||
    finding.status === 'false_positive' ||
    finding.status === 'wont_fix';

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
    if (!error && data) setFinding(data as Finding);
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border border-neutral-800/80 bg-gradient-to-b ${theme.cardBg} transition-all hover:border-neutral-700/80 ${
        isResolved ? 'opacity-70 saturate-50' : ''
      }`}
    >
      <div className={`severity-stripe h-[3px] bg-gradient-to-r ${theme.stripe}`} />

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full px-6 py-5 text-left"
      >
        <div className="flex items-start gap-4">
          <div className="mt-1 flex-shrink-0">
            <Icon className={`h-5 w-5 ${theme.iconColor}`} strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${theme.pill}`}
              >
                {finding.severity}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusTheme.pill}`}
              >
                <StatusIcon className="h-3 w-3" strokeWidth={2.5} />
                {statusTheme.label}
              </span>
              {finding.cvss != null && (
                <span className="rounded-md bg-neutral-900/60 px-2 py-0.5 font-mono text-[10px] text-neutral-300 ring-1 ring-neutral-800">
                  CVSS {finding.cvss}
                </span>
              )}
              {finding.cwe && (
                <span className="rounded-md bg-neutral-900/60 px-2 py-0.5 font-mono text-[10px] text-neutral-400 ring-1 ring-neutral-800">
                  {finding.cwe}
                </span>
              )}
              {(finding.endpoint || finding.method) && (
                <span className="rounded-md bg-neutral-900/60 px-2 py-0.5 font-mono text-[10px] text-cyan-300 ring-1 ring-neutral-800">
                  {[finding.method, finding.endpoint].filter(Boolean).join(' ')}
                </span>
              )}
            </div>

            <h3
              className={`mt-2.5 text-base font-semibold leading-snug sm:text-[17px] ${
                isResolved ? 'text-neutral-300 line-through decoration-neutral-700' : 'text-neutral-50'
              }`}
            >
              {finding.title}
            </h3>

            <p className="mt-1 text-xs italic text-neutral-500">{theme.tagline}</p>

            {summary && (
              <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-neutral-300">
                {summary}
              </p>
            )}
          </div>

          <ChevronDown
            className={`mt-1 h-4 w-4 flex-shrink-0 text-neutral-500 transition-transform duration-200 ${
              expanded ? 'rotate-180 text-neutral-300' : ''
            }`}
            strokeWidth={2}
          />
        </div>
      </button>

      {expanded && (
        <div className="space-y-6 border-t border-neutral-800/60 bg-neutral-950/30 px-6 py-6">
          {finding.target && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-neutral-500">Target:</span>
              <code className="rounded bg-neutral-900/80 px-2 py-0.5 font-mono text-cyan-300 ring-1 ring-neutral-800">
                {finding.target}
              </code>
            </div>
          )}

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

function Markdown({ body }: { body: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-neutral-200 prose-headings:text-neutral-100 prose-p:leading-relaxed prose-p:text-neutral-300 prose-a:font-medium prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline prose-strong:text-neutral-100 prose-code:rounded prose-code:bg-neutral-900 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12.5px] prose-code:font-medium prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-neutral-950 prose-pre:p-3 prose-pre:text-[12px] prose-li:my-0.5 prose-li:text-neutral-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
