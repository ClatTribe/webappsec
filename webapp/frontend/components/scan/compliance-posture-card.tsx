import { CalendarCheck, CalendarClock, Archive } from 'lucide-react';
import type { CompliancePosture } from '@/lib/supabase/types';

// Engine PR #103 / wishlist §10 row — compliance posture dashboard widget.
//
// Reads `run_meta.compliance_posture` (persisted as JSONB by migration 031).
// Auditor-friendly at-a-glance view of:
//   - cadence_status        ("In compliance" / "Overdue")
//   - audit_log_retention_days
//   - days_since_last_scan  (engine-computed; reflects the prior run, not
//                            this one)
//
// Surfaces alongside the vendor-risk + MFA hero widgets when the engine
// supplied the data; renders nothing otherwise.

function inComplianceTheme(status: string | undefined) {
  if (!status) {
    return {
      bg: 'bg-neutral-900/30',
      ring: 'ring-neutral-700/40',
      text: 'text-neutral-300',
      Icon: CalendarClock,
      label: 'Unknown',
    };
  }
  if (/in.compliance|on.cadence|current/i.test(status)) {
    return {
      bg: 'bg-emerald-500/[0.06]',
      ring: 'ring-emerald-500/30',
      text: 'text-emerald-200',
      Icon: CalendarCheck,
      label: status,
    };
  }
  if (/overdue|stale|out.of/i.test(status)) {
    return {
      bg: 'bg-amber-500/[0.06]',
      ring: 'ring-amber-500/30',
      text: 'text-amber-200',
      Icon: CalendarClock,
      label: status,
    };
  }
  return {
    bg: 'bg-neutral-900/30',
    ring: 'ring-neutral-700/40',
    text: 'text-neutral-300',
    Icon: CalendarClock,
    label: status,
  };
}

export default function CompliancePostureCard({
  posture,
}: {
  posture: CompliancePosture;
}) {
  const status = typeof posture.cadence_status === 'string' ? posture.cadence_status : undefined;
  const days =
    typeof posture.days_since_last_scan === 'number'
      && Number.isFinite(posture.days_since_last_scan)
      ? Math.max(0, Math.round(posture.days_since_last_scan))
      : null;
  const retention =
    typeof posture.audit_log_retention_days === 'number'
      && Number.isFinite(posture.audit_log_retention_days)
      ? Math.max(0, Math.round(posture.audit_log_retention_days))
      : null;

  // Hide the card when none of the three signals are populated. This
  // prevents an empty hero tile when the engine emitted an empty
  // `compliance_posture: {}` for a non-compliance-mode scan.
  if (!status && days === null && retention === null) return null;

  const theme = inComplianceTheme(status);
  const Icon = theme.Icon;

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
              Compliance posture
            </span>
            {status && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${theme.bg} ${theme.text} ring-1 ${theme.ring}`}
              >
                {theme.label}
              </span>
            )}
          </div>
          <dl className="space-y-1.5 pt-1 text-[12.5px]">
            {days !== null && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-neutral-400">Days since last scan</dt>
                <dd className={`font-mono tabular-nums ${days > 30 ? 'text-amber-200' : 'text-neutral-200'}`}>
                  {days}
                </dd>
              </div>
            )}
            {retention !== null && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-neutral-400 flex items-center gap-1.5">
                  <Archive className="h-3 w-3 text-neutral-500" strokeWidth={2.25} />
                  Audit log retention
                </dt>
                <dd className="font-mono tabular-nums text-neutral-200">
                  {retention}d
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </section>
  );
}
