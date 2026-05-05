import { TrendingUp, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { VendorRisk, ScanCoverage } from '@/lib/supabase/types';
import { CoverageMutedPill } from '@/components/scan/coverage-banner';

// Engine PR #133 / wishlist §14.8 row 1 — vendor-risk score gauge.
//
// Always shown when present. The engine writes `vendor_risk` to
// run_meta.json regardless of `--vendor-mode` so this widget appears
// for every scan that landed a structured run_meta. Hover reveals the
// top 3 deduction categories — the auditor's "where do I focus?" view.
//
// Score convention (engine PR #133): 0-100, higher = safer. Bands:
//   ≥ 80   low_risk     emerald
//   50-79  medium_risk  amber
//   < 50   high_risk    rose
//
// We trust the engine's `band` field over our own threshold check —
// the engine's bands are tuned to its own deduction model, and a
// future re-tune shouldn't require a wrapper change. Threshold-based
// fallback when `band` is absent (older engines).

interface BandTheme {
  ring: string;
  text: string;
  bg: string;
  Icon: typeof ShieldCheck;
  label: string;
}

const BAND_THEME: Record<string, BandTheme> = {
  low_risk: {
    ring: 'ring-emerald-500/30',
    text: 'text-emerald-200',
    bg: 'bg-emerald-500/[0.06]',
    Icon: ShieldCheck,
    label: 'Low risk',
  },
  medium_risk: {
    ring: 'ring-amber-500/30',
    text: 'text-amber-200',
    bg: 'bg-amber-500/[0.06]',
    Icon: AlertTriangle,
    label: 'Medium risk',
  },
  high_risk: {
    ring: 'ring-rose-500/30',
    text: 'text-rose-200',
    bg: 'bg-rose-500/[0.06]',
    Icon: AlertTriangle,
    label: 'High risk',
  },
};

const NEUTRAL_THEME: BandTheme = {
  ring: 'ring-neutral-700/40',
  text: 'text-neutral-300',
  bg: 'bg-neutral-900/30',
  Icon: TrendingUp,
  label: 'Vendor risk',
};

function bandFromScore(score: number | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  if (score >= 80) return 'low_risk';
  if (score >= 50) return 'medium_risk';
  return 'high_risk';
}

export default function VendorRiskGauge({
  vendor_risk,
  coverage,
}: {
  vendor_risk: VendorRisk;
  /** Tier-A trust-gap fix — when coverage is incomplete, the gauge
   *  renders a "coverage caveat" pill so a 100/100 score isn't read
   *  as authoritative by a customer who skipped the banner above. */
  coverage?: ScanCoverage | null;
}) {
  const score =
    typeof vendor_risk.score === 'number' && Number.isFinite(vendor_risk.score)
      ? Math.max(0, Math.min(100, Math.round(vendor_risk.score)))
      : null;
  if (score === null) return null;

  const band = vendor_risk.band ?? bandFromScore(score);
  const theme = BAND_THEME[band] ?? NEUTRAL_THEME;
  const Icon = theme.Icon;

  // Top 3 deductions, largest absolute value first. The engine reports
  // negative numbers for deductions; we sort by magnitude so the
  // operator sees the most-impactful categories regardless of sign
  // convention.
  const deductions = vendor_risk.deductions_by_category ?? {};
  const topDeductions = Object.entries(deductions)
    .filter(([, v]) => typeof v === 'number' && v !== 0)
    .sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number))
    .slice(0, 3);

  return (
    <section
      className={`rounded-2xl border border-neutral-800/60 ${theme.bg} ring-1 ${theme.ring} p-5`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ring-white/5 ${theme.bg}`}
        >
          <Icon className={`h-7 w-7 ${theme.text}`} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              Vendor risk
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${theme.bg} ${theme.text} ring-1 ${theme.ring}`}
            >
              {theme.label}
            </span>
            {coverage && <CoverageMutedPill coverage={coverage} />}
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-4xl font-semibold tabular-nums ${theme.text}`}>{score}</span>
            <span className="text-sm text-neutral-500">/ 100</span>
          </div>
          {/* Score bar — visual reinforcement of the numeric score. */}
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800/60">
            <div
              className={`h-full ${
                band === 'low_risk'
                  ? 'bg-emerald-400/70'
                  : band === 'medium_risk'
                    ? 'bg-amber-400/70'
                    : 'bg-rose-400/70'
              }`}
              style={{ width: `${score}%` }}
            />
          </div>
          {vendor_risk.recommendation && (
            <p className="pt-1 text-[12.5px] leading-relaxed text-neutral-300">
              {vendor_risk.recommendation}
            </p>
          )}
          {topDeductions.length > 0 && (
            <div className="pt-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Top deduction{topDeductions.length === 1 ? '' : 's'}
              </div>
              <ul className="space-y-1">
                {topDeductions.map(([category, value]) => (
                  <li
                    key={category}
                    className="flex items-center justify-between gap-3 text-[11.5px]"
                  >
                    <span className="font-mono text-neutral-300">{category}</span>
                    <span className="tabular-nums text-neutral-400">
                      {(value as number) > 0 ? '+' : ''}
                      {value as number}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
