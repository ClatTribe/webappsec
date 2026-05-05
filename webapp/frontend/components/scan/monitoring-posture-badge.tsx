import { Activity, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import type { MonitoringPosture } from '@/lib/supabase/types';

// Engine PR #128 / wishlist §14.3 — logging + monitoring posture badge.
//
// 0-6 score across redaction (PII / secrets / auth tokens), reporting
// (CSP / error pipeline), and rate-limit observability. Tied to the
// auditor's "are you logging the right things and protecting the
// wrong ones?" question.
//
// Reads `run_meta.monitoring_posture` (already persisted by migration
// 031). Each breakdown key renders as a chip (eye icon / eye-slashed
// for present/absent). Hidden when the engine didn't emit a score.

const BREAKDOWN_LABELS: Record<string, string> = {
  pii_redaction:       'PII redacted',
  secrets_redaction:   'secrets redacted',
  auth_redaction:      'auth tokens redacted',
  csp_reporting:       'CSP report-uri',
  error_reporting:     'error pipeline',
  rate_limit_observed: 'rate-limit observed',
};

function bandTheme(score: number, max: number) {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 1) {
    return {
      ring: 'ring-emerald-500/30',
      bg: 'bg-emerald-500/[0.06]',
      text: 'text-emerald-200',
      Icon: Activity,
      label: 'Mature',
    };
  }
  if (ratio >= 0.5) {
    return {
      ring: 'ring-amber-500/30',
      bg: 'bg-amber-500/[0.06]',
      text: 'text-amber-200',
      Icon: AlertTriangle,
      label: 'Partial',
    };
  }
  return {
    ring: 'ring-rose-500/30',
    bg: 'bg-rose-500/[0.06]',
    text: 'text-rose-200',
    Icon: AlertTriangle,
    label: 'Weak',
  };
}

export default function MonitoringPostureBadge({ posture }: { posture: MonitoringPosture }) {
  const score =
    typeof posture.score === 'number' && Number.isFinite(posture.score)
      ? Math.max(0, posture.score)
      : null;
  const max =
    typeof posture.max === 'number' && Number.isFinite(posture.max) && posture.max > 0
      ? posture.max
      : 6;

  if (score === null) return null;

  const theme = bandTheme(score, max);
  const Icon = theme.Icon;
  const breakdown = posture.breakdown ?? null;
  const breakdownKeys = breakdown ? Object.keys(breakdown) : [];

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
              Monitoring posture
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${theme.bg} ${theme.text} ring-1 ${theme.ring}`}
            >
              {theme.label}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-4xl font-semibold tabular-nums ${theme.text}`}>{score}</span>
            <span className="text-sm text-neutral-500">/ {max}</span>
          </div>
          {breakdownKeys.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {breakdownKeys.map((key) => {
                const present = Boolean(
                  (breakdown as Record<string, unknown>)[key],
                );
                const label = BREAKDOWN_LABELS[key] ?? key.replace(/_/g, ' ');
                const ChipIcon = present ? Eye : EyeOff;
                return (
                  <span
                    key={key}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${
                      present
                        ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/20'
                        : 'bg-neutral-800/40 text-neutral-500 ring-neutral-700/40'
                    }`}
                  >
                    <ChipIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                    {label}
                  </span>
                );
              })}
            </div>
          )}
          {posture.recommendation && (
            <p className="pt-1 text-[12.5px] leading-relaxed text-neutral-300">
              {posture.recommendation}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
