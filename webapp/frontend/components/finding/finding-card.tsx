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
} from 'lucide-react';
import type { Finding, Severity } from '@/lib/supabase/types';

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

export default function FindingCard({ finding, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const theme = SEVERITY_THEME[finding.severity];
  const { summary, sections } = parseFindingMarkdown(finding.description_md);
  const Icon = theme.Icon;

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border border-neutral-800/80 bg-gradient-to-b ${theme.cardBg} transition-all hover:border-neutral-700/80`}
    >
      {/* Severity stripe + glow */}
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

            <h3 className="mt-2.5 text-base font-semibold leading-snug text-neutral-50 sm:text-[17px]">
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
        </div>
      )}
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
