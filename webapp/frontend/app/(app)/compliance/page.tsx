// Compliance questionnaire pre-fill page — Tier A #2 ("the killer feature").
//
// For the vibe-coded founder whose prospect just sent a 200-question
// vendor security assessment. They pick a template (SOC 2 SAQ / SIG /
// CAIQ), the page joins TensorShield's compliance_evidence verdicts to
// the question library, and they export the pre-filled answers as
// CSV / JSON to paste into the prospect's spreadsheet.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Gauge, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import QuestionnaireClient from './questionnaire-client';

export const metadata = {
  title: 'Compliance · Questionnaires',
};

interface AvailableTemplate {
  key: string;
  framework: string;
  question_count: number;
}

// Inline-rendered chip on top of the page — see ReadinessChips below.
interface ReadinessChipShape {
  framework: string;
  composite_pct: number;
  prev_score: number | null;
}

const FRAMEWORK_LABEL: Record<string, string> = {
  soc_2: 'SOC 2',
  iso_27001: 'ISO 27001',
  pci_dss: 'PCI DSS 4.0',
  hipaa: 'HIPAA',
  nist_800_53: 'NIST 800-53',
  gdpr: 'GDPR',
  fedramp_high: 'FedRAMP High',
  csa_caiq: 'CSA CAIQ',
  owasp_asvs: 'OWASP ASVS',
};

export default async function CompliancePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Two queries in parallel: the questionnaire template list (existing)
  // and the live audit-readiness rollup (Tier II #12).
  const [{ data: rows }, { data: readiness }] = await Promise.all([
    supabase.from('compliance_questionnaire_templates').select('key, framework').order('key'),
    supabase.rpc('compute_org_audit_readiness'),
  ]);

  const grouped = new Map<string, AvailableTemplate>();
  for (const row of (rows ?? []) as Array<{ key: string; framework: string }>) {
    const ex = grouped.get(row.key);
    if (ex) {
      ex.question_count += 1;
    } else {
      grouped.set(row.key, {
        key: row.key,
        framework: row.framework,
        question_count: 1,
      });
    }
  }
  const templates = Array.from(grouped.values());

  // The RPC's OUT params use the `out_` prefix to dodge plpgsql
  // identifier shadowing — strip it here so the chip component reads
  // cleanly. See migration 070 comment for why.
  const chips: ReadinessChipShape[] = ((readiness ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({
      framework: (r.out_framework ?? r.framework) as string,
      composite_pct: (r.out_composite_pct ?? r.composite_pct) as number,
      prev_score: (r.out_prev_score ?? r.prev_score) as number | null,
    }))
    .sort((a, b) => b.composite_pct - a.composite_pct);

  return (
    <div className="space-y-6">
      {chips.length > 0 && <ReadinessChips chips={chips} />}
      <QuestionnaireClient templates={templates} />
    </div>
  );
}

function ReadinessChips({ chips }: { chips: ReadinessChipShape[] }) {
  // Split the card into header (with two sibling links — readiness +
  // compensating) and a clickable chip list (its own Link). Avoids
  // nesting anchors, which is invalid HTML.
  return (
    <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Gauge className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
          <h2 className="text-sm font-medium uppercase tracking-wider text-cyan-200">
            Audit readiness
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {/* Tier II #13 — quick link to compensating controls UI.
              Pinned here because users that look at readiness scores
              are the most likely to need the "we mitigate this differently"
              escape hatch. */}
          <Link
            href="/compliance/compensating"
            className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/20"
          >
            Compensating controls
          </Link>
          <Link
            href="/compliance/readiness"
            className="inline-flex items-center gap-0.5 text-[11px] text-cyan-200/80 hover:text-cyan-100"
          >
            full breakdown
            <ChevronRight className="h-3 w-3" strokeWidth={2.5} />
          </Link>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {chips.map((c) => {
          const delta = c.prev_score !== null ? c.composite_pct - c.prev_score : null;
          const tone = c.composite_pct >= 85
            ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/30'
            : c.composite_pct >= 65
              ? 'bg-cyan-500/10 text-cyan-200 ring-cyan-400/30'
              : c.composite_pct >= 40
                ? 'bg-amber-500/10 text-amber-200 ring-amber-400/30'
                : 'bg-rose-500/10 text-rose-200 ring-rose-400/30';
          return (
            <li
              key={c.framework}
              className={`inline-flex items-baseline gap-1.5 rounded-md px-2.5 py-1 text-[12px] ring-1 ${tone}`}
            >
              <span className="font-semibold">
                {FRAMEWORK_LABEL[c.framework] ?? c.framework}
              </span>
              <span className="font-mono text-[13px]">{c.composite_pct}%</span>
              {delta !== null && delta !== 0 && (
                <span
                  className={`text-[10px] ${delta > 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                >
                  {delta > 0 ? '+' : ''}
                  {delta}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
