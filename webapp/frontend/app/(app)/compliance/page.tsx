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

  // Three queries in parallel: the questionnaire template list
  // (existing), the live audit-readiness rollup (Tier II #12), and the
  // CIS attestation rollup (wishlist §17.5).
  const [{ data: rows }, { data: readiness }, { data: cisEvidence }] = await Promise.all([
    supabase.from('compliance_questionnaire_templates').select('key, framework').order('key'),
    supabase.rpc('compute_org_audit_readiness'),
    supabase
      .from('compliance_evidence')
      .select('framework, control_id, verdict')
      .in('framework', ['cis_aws', 'cis_gcp', 'cis_azure', 'cis_kubernetes', 'cis_docker']),
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

  // Wishlist §17.5 — CIS attestation rollup. Per framework, count
  // distinct control_ids the latest scan attested with a pass / warn
  // verdict. Denominator pulled from CIS_TOTALS (the published
  // benchmark counts; we keep them in code so a new control catalog
  // version is a code change, not a DB migration). 'untested' rows
  // are excluded — they're attested by absence, not by an active
  // verdict.
  const cisRollupRows = (cisEvidence ?? []) as Array<{
    framework: string;
    control_id: string;
    verdict: string;
  }>;
  const cisAttestation = computeCisRollup(cisRollupRows);

  return (
    <div className="space-y-6">
      {chips.length > 0 && <ReadinessChips chips={chips} />}
      {cisAttestation.length > 0 && <CisAttestationCard rows={cisAttestation} />}
      <QuestionnaireClient templates={templates} />
    </div>
  );
}

// Wishlist §17.5 — CIS benchmark attestation rollup.
//
// Denominators come from the published benchmark counts. The numerator
// is the count of distinct control_ids in `compliance_evidence` for
// this framework with verdict ∈ {pass, warn}. We deliberately don't
// count `fail` toward attestation — an attested fail is not the same
// thing as "the auditor saw it"; the auditor saw a control they would
// fail you on, not a control you've satisfied.
//
// CIS_TOTALS values reflect the published benchmark profiles:
//   - cis_aws        CIS AWS Foundations Benchmark v3.0 (Level 1+2)
//   - cis_gcp        CIS GCP Foundations Benchmark v3.0
//   - cis_azure      CIS Azure Foundations Benchmark v2.0
//   - cis_kubernetes CIS Kubernetes Benchmark v1.9
//   - cis_docker     CIS Docker Benchmark v1.6
//
// These numbers update annually when the benchmarks ship a new
// version. A bump here is a code change, not a migration.
const CIS_TOTALS: Record<string, number> = {
  cis_aws: 57,
  cis_gcp: 60,
  cis_azure: 55,
  cis_kubernetes: 122,
  cis_docker: 117,
};

const CIS_LABELS: Record<string, string> = {
  cis_aws: 'CIS AWS Foundations',
  cis_gcp: 'CIS GCP Foundations',
  cis_azure: 'CIS Azure Foundations',
  cis_kubernetes: 'CIS Kubernetes',
  cis_docker: 'CIS Docker',
};

interface CisRow {
  framework: string;
  label: string;
  attested: number;
  failing: number;
  total: number;
  pct: number;
}

function computeCisRollup(
  rows: Array<{ framework: string; control_id: string; verdict: string }>,
): CisRow[] {
  const byFw = new Map<string, { attested: Set<string>; failing: Set<string> }>();
  for (const r of rows) {
    let bucket = byFw.get(r.framework);
    if (!bucket) {
      bucket = { attested: new Set(), failing: new Set() };
      byFw.set(r.framework, bucket);
    }
    if (r.verdict === 'pass' || r.verdict === 'warn') {
      bucket.attested.add(r.control_id);
    } else if (r.verdict === 'fail') {
      bucket.failing.add(r.control_id);
    }
  }
  const out: CisRow[] = [];
  for (const [fw, sets] of byFw) {
    const total = CIS_TOTALS[fw] ?? sets.attested.size + sets.failing.size;
    const attested = sets.attested.size;
    out.push({
      framework: fw,
      label: CIS_LABELS[fw] ?? fw,
      attested,
      failing: sets.failing.size,
      total,
      pct: total > 0 ? Math.round((attested / total) * 100) : 0,
    });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

function CisAttestationCard({ rows }: { rows: CisRow[] }) {
  return (
    <section className="rounded-2xl border border-orange-500/20 bg-orange-500/[0.04] px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Gauge className="h-4 w-4 text-orange-300" strokeWidth={2.25} />
          <h2 className="text-sm font-medium uppercase tracking-wider text-orange-200">
            CIS benchmark attestation
          </h2>
        </div>
        <span className="text-[10.5px] text-orange-200/70">
          attested = distinct controls with pass or warn verdicts in your latest scan
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.framework}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border border-orange-500/10 bg-orange-500/[0.03] px-3 py-1.5"
          >
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-orange-100">{r.label}</div>
              <div className="text-[10.5px] text-orange-200/70">
                {r.attested} attested · {r.failing} failing · {r.total} total controls
              </div>
            </div>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-orange-500/10">
              <div
                className="h-full rounded-full bg-orange-400/80"
                style={{ width: `${Math.max(2, r.pct)}%` }}
              />
            </div>
            <span className="font-mono text-[13px] tabular-nums text-orange-100">
              {r.pct}%
            </span>
          </li>
        ))}
      </ul>
    </section>
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
          {/* Continuous evidence collectors — the operational-SaaS
              auto-pull. The "Vanta competitor" feature in one phrase. */}
          <Link
            href="/compliance/collectors"
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 hover:bg-emerald-500/20"
          >
            Continuous evidence
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
