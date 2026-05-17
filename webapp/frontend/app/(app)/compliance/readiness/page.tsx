import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ChevronRight,
  Gauge,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  CheckCircle2,
  Activity,
  Clock,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import type { AuditReadinessRow, ComplianceSnapshot } from '@/lib/supabase/types';

// Tier II #12 — Compliance audit-readiness dashboard.
//
// /compliance/readiness
//
// For each framework the org has at least one compliance_evidence row
// for, render:
//   - 0-100 composite score with delta vs. last quarter
//   - 5-component breakdown (base readiness, coverage, cadence,
//     findings drag, freshness)
//   - Quarterly history sparkline drawn from compliance_snapshots
//
// The score is computed live on every page render — the snapshot
// table only captures quarterly history. (The live score is cheap;
// the snapshot is a defensible procurement artifact.)

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

export const metadata = {
  title: 'Compliance · Audit readiness',
};

export default async function ReadinessPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Live per-framework scores.
  const { data: rowsRaw, error } = await supabase.rpc('compute_org_audit_readiness');

  // RPC returns out_-prefixed columns; strip the prefix for ergonomic access.
  const rows: AuditReadinessRow[] = ((rowsRaw ?? []) as Array<Record<string, unknown>>).map((r) => ({
    framework: (r.out_framework ?? r.framework) as string,
    composite_pct: (r.out_composite_pct ?? r.composite_pct) as number,
    base_readiness_pct: Number(r.out_base_readiness_pct ?? r.base_readiness_pct ?? 0),
    coverage_pct: Number(r.out_coverage_pct ?? r.coverage_pct ?? 0),
    cadence_pct: (r.out_cadence_pct ?? r.cadence_pct) as number,
    findings_pct: (r.out_findings_pct ?? r.findings_pct) as number,
    freshness_pct: (r.out_freshness_pct ?? r.freshness_pct) as number,
    open_crit_findings: (r.out_open_crit_findings ?? r.open_crit_findings) as number,
    open_high_findings: (r.out_open_high_findings ?? r.open_high_findings) as number,
    stale_controls: (r.out_stale_controls ?? r.stale_controls) as number,
    total_controls: (r.out_total_controls ?? r.total_controls) as number,
    touched_controls: (r.out_touched_controls ?? r.touched_controls) as number,
    days_since_last_scan: (r.out_days_since_last_scan ?? r.days_since_last_scan) as number,
    prev_quarter: (r.out_prev_quarter ?? r.prev_quarter) as string | null,
    prev_score: (r.out_prev_score ?? r.prev_score) as number | null,
  }));

  // Full quarterly history for the sparkline. One round-trip vs N+1.
  // Plus questionnaire-template control catalog for the coverage-gap
  // surface (wishlist §18.6).
  const [{ data: history }, { data: qtRows }, { data: ceRows }] = await Promise.all([
    supabase
      .from('compliance_snapshots')
      .select('id, org_id, framework, quarter, score, breakdown, snapshot_at')
      .order('quarter', { ascending: true })
      .limit(200),
    supabase
      .from('compliance_questionnaire_templates')
      .select('framework, control_ids'),
    supabase
      .from('compliance_evidence')
      .select('framework, control_id, verdict'),
  ]);

  const historyByFramework = new Map<string, ComplianceSnapshot[]>();
  for (const h of (history ?? []) as ComplianceSnapshot[]) {
    if (!historyByFramework.has(h.framework)) historyByFramework.set(h.framework, []);
    historyByFramework.get(h.framework)!.push(h);
  }

  // Wishlist §18.6 — untested-controls coverage gap.
  //
  // Catalog: every distinct control_id mapped on a questionnaire template
  // for each framework. (We deliberately use the seeded SAQ rows as the
  // denominator rather than hardcoding catalog totals — keeps the
  // denominators editable from migrations + accurate per-framework.)
  //
  // Attested: distinct control_ids with verdict ∈ {pass, warn} in
  // compliance_evidence.
  //
  // Gap = catalog − attested.
  const coverageGaps = computeCoverageGaps(
    (qtRows ?? []) as Array<{ framework: string; control_ids: string[] | null }>,
    (ceRows ?? []) as Array<{ framework: string; control_id: string; verdict: string }>,
  );

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Link href="/compliance" className="transition-colors hover:text-neutral-300">
            Compliance
          </Link>
          <span>·</span>
          <span className="text-neutral-300">Audit readiness</span>
        </nav>
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Audit readiness</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Per-framework 0-100 composite score across base readiness, coverage,
          scan cadence, open critical findings, and evidence freshness. Updated
          live on every page load; quarterly snapshots persist so you can show
          progress over time.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          Failed to compute readiness: {error.message}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-12 text-center">
          <div className="text-sm text-neutral-400">
            No compliance evidence yet. Run a scan with a framework mapping enabled
            (SOC 2, ISO 27001, PCI DSS, HIPAA, NIST 800-53) and your readiness score
            will appear here.
          </div>
          <Link
            href="/scans/new"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
          >
            Start a scan
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <FrameworkCard
              key={r.framework}
              row={r}
              history={historyByFramework.get(r.framework) ?? []}
            />
          ))}
        </ul>
      )}

      {coverageGaps.length > 0 && <CoverageGapsPanel gaps={coverageGaps} />}
    </div>
  );
}

// =============== Wishlist §18.6 — coverage gaps ===================
//
// Per-framework "controls in the catalog that NO attestation maps to."
// Read by /compliance/readiness; auditor-trust pillar — honest about
// what we don't cover beats a 100% green dashboard.

interface CoverageGapRow {
  framework: string;
  attested: number;
  gap_count: number;
  total: number;
  gap_controls: string[];
}

function computeCoverageGaps(
  qtRows: Array<{ framework: string; control_ids: string[] | null }>,
  ceRows: Array<{ framework: string; control_id: string; verdict: string }>,
): CoverageGapRow[] {
  // Catalog = every distinct control_id appearing on any questionnaire
  // template for this framework.
  const catalogByFw = new Map<string, Set<string>>();
  for (const t of qtRows) {
    if (!Array.isArray(t.control_ids)) continue;
    let bucket = catalogByFw.get(t.framework);
    if (!bucket) {
      bucket = new Set();
      catalogByFw.set(t.framework, bucket);
    }
    for (const c of t.control_ids) {
      if (typeof c === 'string' && c.trim()) bucket.add(c.trim());
    }
  }

  // Attested = control_ids with pass/warn verdict in compliance_evidence.
  const attestedByFw = new Map<string, Set<string>>();
  for (const e of ceRows) {
    if (!['pass', 'warn'].includes(e.verdict)) continue;
    let bucket = attestedByFw.get(e.framework);
    if (!bucket) {
      bucket = new Set();
      attestedByFw.set(e.framework, bucket);
    }
    bucket.add(e.control_id);
  }

  const rows: CoverageGapRow[] = [];
  for (const [framework, catalog] of catalogByFw) {
    const attested = attestedByFw.get(framework) ?? new Set<string>();
    const gap = [...catalog].filter((c) => !attested.has(c)).sort();
    if (catalog.size === 0) continue;
    rows.push({
      framework,
      attested: attested.size,
      gap_count: gap.length,
      total: catalog.size,
      gap_controls: gap,
    });
  }
  // Most-gappy framework first — that's the one the operator should
  // focus on / acknowledge to the auditor.
  return rows.sort((a, b) => b.gap_count - a.gap_count);
}

function CoverageGapsPanel({ gaps }: { gaps: CoverageGapRow[] }) {
  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-5">
      <div className="flex items-center gap-2.5">
        <AlertCircle className="h-4 w-4 text-amber-300" strokeWidth={2.25} />
        <h2 className="text-sm font-medium uppercase tracking-wider text-amber-200">
          Coverage gaps
        </h2>
        <span className="text-[10.5px] text-amber-200/70">
          controls in the framework catalog that no scan attests yet
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-amber-100/80">
        Honest signal for the auditor: these controls live in the framework
        catalog but no current scan produces an attestation for them. Either
        a separate process attests these (policy / training / physical access),
        or the org should acknowledge the gap. Auditors trust dashboards that
        are honest about scope.
      </p>
      <ul className="space-y-2">
        {gaps.map((g) => (
          <li key={g.framework}>
            <details className="rounded-lg border border-amber-500/15 bg-neutral-950/30 px-3 py-2">
              <summary className="cursor-pointer text-[12px]">
                <span className="font-medium text-amber-100">
                  {FRAMEWORK_LABEL[g.framework] ?? g.framework}
                </span>
                <span className="ml-2 text-[10.5px] text-amber-200/70">
                  {g.attested} attested · <strong>{g.gap_count} gap</strong> · {g.total} catalog
                </span>
              </summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {g.gap_controls.slice(0, 50).map((c) => (
                  <code
                    key={c}
                    className="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
                  >
                    {c}
                  </code>
                ))}
                {g.gap_controls.length > 50 && (
                  <span className="text-[10px] text-neutral-500">
                    + {g.gap_controls.length - 50} more
                  </span>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FrameworkCard({
  row,
  history,
}: {
  row: AuditReadinessRow;
  history: ComplianceSnapshot[];
}) {
  const delta = row.prev_score !== null ? row.composite_pct - row.prev_score : null;
  const scoreTone = scoreToneClass(row.composite_pct);

  return (
    <li className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/30">
      {/* Header row: score + framework name + delta + sparkline ----- */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4">
        <div className={`flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl text-2xl font-semibold ${scoreTone.bg} ${scoreTone.text} ring-1 ${scoreTone.ring}`}>
          {row.composite_pct}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-semibold text-neutral-100">
              {FRAMEWORK_LABEL[row.framework] ?? row.framework}
            </span>
            <span className="text-[11px] text-neutral-500">
              {row.touched_controls} of {row.total_controls} controls evaluated
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px]">
            <DeltaPill delta={delta} prevQuarter={row.prev_quarter} />
            {row.days_since_last_scan < 9999 && (
              <span className="inline-flex items-center gap-1 text-neutral-500">
                <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                last scan {row.days_since_last_scan}d ago
              </span>
            )}
          </div>
        </div>

        {/* Sparkline ---------------------------------------------- */}
        {history.length >= 2 && <Sparkline points={history.map((h) => h.score)} />}
      </div>

      {/* Component breakdown bar ---------------------------------- */}
      <div className="grid grid-cols-5 gap-1.5 border-t border-neutral-800/60 bg-neutral-950/40 p-3">
        <Component label="Base readiness" pct={row.base_readiness_pct} weight={30} hint="% of evaluated controls passing" />
        <Component label="Coverage" pct={row.coverage_pct} weight={20} hint="% of controls evaluated at all" />
        <Component label="Cadence" pct={row.cadence_pct} weight={20} hint="Recency of the most recent scan" />
        <Component label="Findings drag" pct={row.findings_pct} weight={20} hint={`${row.open_crit_findings} critical · ${row.open_high_findings} high open on mapped controls`} />
        <Component label="Freshness" pct={row.freshness_pct} weight={10} hint={`${row.stale_controls} evidence rows past expiry`} />
      </div>

      {/* Alert strip ----------------------------------------------- */}
      <Callouts row={row} />
    </li>
  );
}

function Component({
  label,
  pct,
  weight,
  hint,
}: {
  label: string;
  pct: number;
  weight: number;
  hint: string;
}) {
  const pctRounded = Math.round(pct);
  const tone = scoreToneClass(pctRounded);
  return (
    <div className="space-y-1 rounded-md border border-neutral-800/60 bg-neutral-900/40 px-2 py-1.5" title={hint}>
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-neutral-400">
          {label}
        </span>
        <span className="text-[9px] text-neutral-600">×{weight}%</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-base font-semibold ${tone.text}`}>{pctRounded}</span>
        <span className="text-[10px] text-neutral-500">/ 100</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full ${tone.bar}`}
          style={{ width: `${Math.max(2, pctRounded)}%` }}
        />
      </div>
    </div>
  );
}

function DeltaPill({
  delta,
  prevQuarter,
}: {
  delta: number | null;
  prevQuarter: string | null;
}) {
  if (delta === null || !prevQuarter) {
    return (
      <span className="text-[10.5px] text-neutral-500">
        no prior snapshot yet
      </span>
    );
  }
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const tone =
    delta > 0
      ? 'text-emerald-300'
      : delta < 0
        ? 'text-rose-300'
        : 'text-neutral-400';
  const sign = delta > 0 ? '+' : '';
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <Icon className="h-3 w-3" strokeWidth={2.5} />
      {sign}
      {delta} from {prevQuarter}
    </span>
  );
}

function Callouts({ row }: { row: AuditReadinessRow }) {
  const items: Array<{
    tone: 'amber' | 'rose' | 'emerald';
    text: string;
    Icon: typeof AlertCircle;
    cta?: { href: string; label: string };
  }> = [];

  if (row.open_crit_findings > 0) {
    items.push({
      tone: 'rose',
      Icon: AlertCircle,
      text: `${row.open_crit_findings} critical finding${row.open_crit_findings === 1 ? '' : 's'} tagged against mapped controls — score drops by ${10 * row.open_crit_findings} until resolved.`,
      // Tier II #13 — quick path to declare a mitigation if the finding
      // can't be directly fixed (e.g., legacy SAML IdP without MFA).
      cta: { href: '/compliance/compensating', label: 'Declare compensating control' },
    });
  }
  if (row.stale_controls > 0) {
    items.push({
      tone: 'amber',
      Icon: Clock,
      text: `${row.stale_controls} evidence row${row.stale_controls === 1 ? '' : 's'} past expiry — re-collect or extend.`,
    });
  }
  if (row.days_since_last_scan > 30 && row.days_since_last_scan < 9999) {
    items.push({
      tone: 'amber',
      Icon: Activity,
      text: `Last scan was ${row.days_since_last_scan} days ago — auditors expect at most quarterly cadence.`,
    });
  }
  if (row.composite_pct >= 85 && items.length === 0) {
    items.push({
      tone: 'emerald',
      Icon: CheckCircle2,
      text: `Strong audit posture. Snapshot now to lock in the score for your trust page.`,
    });
  }

  if (items.length === 0) return null;
  return (
    <ul className="divide-y divide-neutral-800/60 border-t border-neutral-800/60">
      {items.map((it, i) => {
        const cls = {
          amber: 'text-amber-200 bg-amber-500/[0.04]',
          rose: 'text-rose-200 bg-rose-500/[0.04]',
          emerald: 'text-emerald-200 bg-emerald-500/[0.04]',
        }[it.tone];
        return (
          <li key={i} className={`flex items-start gap-2 px-5 py-2.5 text-[11.5px] ${cls}`}>
            <it.Icon className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2.5} />
            <span className="flex-1">{it.text}</span>
            {it.cta && (
              <Link
                href={it.cta.href}
                className="flex-shrink-0 rounded-md border border-current/30 px-2 py-0.5 text-[10.5px] font-medium hover:bg-white/5"
              >
                {it.cta.label}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const W = 90;
  const H = 28;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 100);
  const range = max - min || 1;
  const step = W / (points.length - 1);
  const pts = points
    .map((p, i) => {
      const x = i * step;
      const y = H - ((p - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="flex-shrink-0"
      aria-label={`${points.length}-quarter score trend, latest ${last}`}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        points={pts}
        className="text-cyan-300/70"
      />
    </svg>
  );
}

function scoreToneClass(score: number): {
  bg: string;
  text: string;
  ring: string;
  bar: string;
} {
  if (score >= 85) {
    return {
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-300',
      ring: 'ring-emerald-400/30',
      bar: 'bg-emerald-400/70',
    };
  }
  if (score >= 65) {
    return {
      bg: 'bg-cyan-500/15',
      text: 'text-cyan-300',
      ring: 'ring-cyan-400/30',
      bar: 'bg-cyan-400/70',
    };
  }
  if (score >= 40) {
    return {
      bg: 'bg-amber-500/15',
      text: 'text-amber-300',
      ring: 'ring-amber-400/30',
      bar: 'bg-amber-400/70',
    };
  }
  return {
    bg: 'bg-rose-500/15',
    text: 'text-rose-300',
    ring: 'ring-rose-400/30',
    bar: 'bg-rose-400/70',
  };
}
