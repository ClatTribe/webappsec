import Link from 'next/link';
import { ShieldAlert, GitFork, ListFilter, Repeat, AlertTriangle } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import RecurringClient from './recurring-client';
import type { FingerprintRollupRow } from '@/lib/supabase/types';

// Tier II #11 — Cross-scan finding rollup.
//
// /findings/recurring
//
// Lists each fingerprint that hits >= 2 distinct targets, with counts,
// status breakdown, and a drill-in button that fetches per-target
// detail + offers bulk triage. The server fetches the rollup via the
// fingerprint_rollup() RPC; the client handles drill-in / triage.

export default async function RecurringFindingsPage() {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('fingerprint_rollup');
  const rows = ((error ? [] : (data ?? [])) as FingerprintRollupRow[]) ?? [];

  // Top-line tally so the header is informative at a glance.
  const totalGroups = rows.length;
  const totalOccurrences = rows.reduce((s, r) => s + r.occurrence_count, 0);
  const totalOpen = rows.reduce((s, r) => s + r.open_count, 0);
  const totalTargets = rows.reduce((s, r) => s + r.target_count, 0);
  const criticalGroups = rows.filter((r) => r.severity === 'critical').length;
  const highGroups = rows.filter((r) => r.severity === 'high').length;

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Link href="/findings" className="transition-colors hover:text-neutral-300">
            Findings
          </Link>
          <span>·</span>
          <span className="text-neutral-300">Recurring</span>
        </nav>

        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2">
              <Repeat className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
              <h1 className="text-3xl font-semibold tracking-tight">Recurring findings</h1>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-neutral-400">
              Fingerprints that hit two or more targets in your org. Triage a class
              once and apply it to every occurrence — instead of fixing the same
              XSS in twelve repos one at a time.
            </p>
          </div>
          <Link
            href="/findings"
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
          >
            <ListFilter className="h-3.5 w-3.5" strokeWidth={2.25} />
            Back to all findings
          </Link>
        </div>

        {rows.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label="Recurring groups"
              value={totalGroups}
              Icon={GitFork}
              tone="cyan"
              detail={`across ${totalTargets} target-hits`}
            />
            <Tile
              label="Open occurrences"
              value={totalOpen}
              Icon={ShieldAlert}
              tone="amber"
              detail={`of ${totalOccurrences} total`}
            />
            <Tile
              label="Critical groups"
              value={criticalGroups}
              Icon={AlertTriangle}
              tone="rose"
              detail={`+ ${highGroups} high-severity`}
            />
            <Tile
              label="Bulk-triageable"
              value={totalOpen}
              Icon={Repeat}
              tone="violet"
              detail="open rows you can resolve in one click"
            />
          </div>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-12 text-center">
          <div className="text-sm text-neutral-400">
            No recurring findings yet — either every fingerprint hit exactly one target,
            or you haven&apos;t scanned multiple targets yet.
          </div>
          <Link
            href="/scans/new"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
          >
            Start a scan
          </Link>
        </div>
      ) : (
        <RecurringClient rows={rows} />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  Icon,
  tone,
  detail,
}: {
  label: string;
  value: number;
  Icon: typeof Repeat;
  tone: 'rose' | 'amber' | 'cyan' | 'violet';
  detail: string;
}) {
  const accent = {
    rose: 'text-rose-300/90 ring-rose-500/20',
    amber: 'text-amber-300/90 ring-amber-500/20',
    cyan: 'text-cyan-300/90 ring-cyan-500/20',
    violet: 'text-violet-300/90 ring-violet-500/20',
  }[tone];
  return (
    <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        <span className={`rounded-md p-0.5 ring-1 ${accent}`}>
          <Icon className="h-3 w-3" strokeWidth={2.5} />
        </span>
      </div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
      <div className="text-[10.5px] text-neutral-500">{detail}</div>
    </div>
  );
}
