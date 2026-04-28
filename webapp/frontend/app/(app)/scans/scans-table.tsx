'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
  XCircle,
  Pause,
  ArrowRight,
  Target as TargetIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Scan, ScanStatus } from '@/lib/supabase/types';

type ScanWithTarget = Scan & {
  targets?: { id: string; name: string; type: string } | null;
};

const STATUS_THEME: Record<ScanStatus, { Icon: LucideIcon; tag: string }> = {
  queued: { Icon: Pause, tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
  running: { Icon: Activity, tag: 'bg-blue-500/15 text-blue-200 ring-blue-500/30' },
  completed: { Icon: CheckCircle2, tag: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' },
  failed: { Icon: XCircle, tag: 'bg-red-500/15 text-red-200 ring-red-500/30' },
  cancelled: { Icon: XCircle, tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
};

const ALL_TARGETS = '__all__';

export default function ScansTable({ scans }: { scans: ScanWithTarget[] }) {
  const [targetFilter, setTargetFilter] = useState<string>(ALL_TARGETS);

  const targetOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of scans) {
      if (s.target_id && s.targets?.name) seen.set(s.target_id, s.targets.name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [scans]);

  const visible = useMemo(
    () =>
      targetFilter === ALL_TARGETS
        ? scans
        : scans.filter((s) => s.target_id === targetFilter),
    [scans, targetFilter],
  );

  return (
    <div className="space-y-3">
      {targetOptions.length > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3">
          <div className="relative inline-flex items-center">
            <TargetIcon
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-cyan-400/70"
              strokeWidth={2.25}
            />
            <select
              value={targetFilter}
              onChange={(e) => setTargetFilter(e.target.value)}
              className="appearance-none rounded-lg border border-neutral-800 bg-neutral-950/60 py-1.5 pl-8 pr-7 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            >
              <option value={ALL_TARGETS}>All targets</option>
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 text-neutral-500">▾</span>
          </div>
          <div className="text-[11px] text-neutral-500">
            {targetFilter === ALL_TARGETS
              ? `${scans.length} scan${scans.length === 1 ? '' : 's'} total`
              : `${visible.length} of ${scans.length} scan${scans.length === 1 ? '' : 's'}`}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
        {visible.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800/80 bg-neutral-900/40">
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-neutral-500">
                <th className="px-5 py-3 font-semibold">Target</th>
                <th className="px-5 py-3 font-semibold">Run</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Mode</th>
                <th className="px-5 py-3 font-semibold">Cost</th>
                <th className="px-5 py-3 font-semibold">Started</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {visible.map((scan) => {
                const theme = STATUS_THEME[scan.status as ScanStatus];
                const Icon = theme.Icon;
                return (
                  <tr key={scan.id} className="group transition-colors hover:bg-neutral-900/40">
                    <td className="px-5 py-3.5">
                      {scan.targets ? (
                        <Link
                          href={`/targets/${scan.targets.id}`}
                          className="inline-flex items-center gap-1.5 text-neutral-200 transition-colors hover:text-cyan-300"
                        >
                          <TargetIcon className="h-3.5 w-3.5 text-cyan-400/70" strokeWidth={2} />
                          <span className="font-medium">{scan.targets.name}</span>
                        </Link>
                      ) : (
                        <span className="text-neutral-500">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/scans/${scan.id}`}
                        className="font-medium text-neutral-100 transition-colors hover:text-cyan-300"
                      >
                        {scan.run_name}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${theme.tag}`}
                      >
                        <Icon className="h-3 w-3" strokeWidth={2.5} />
                        {scan.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-neutral-300">{scan.scan_mode}</td>
                    <td className="px-5 py-3.5 text-neutral-400">
                      ${scan.total_cost?.toFixed(2) ?? '0.00'}
                    </td>
                    <td className="px-5 py-3.5 text-neutral-400">
                      {scan.started_at ? (
                        new Date(scan.started_at).toLocaleString()
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        href={`/scans/${scan.id}`}
                        className="inline-flex items-center gap-1 text-xs text-neutral-500 transition-all hover:text-cyan-300 group-hover:translate-x-0.5"
                      >
                        View
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-12 text-center text-sm text-neutral-500">
            {scans.length === 0 ? (
              <>
                No scans yet.{' '}
                <Link href="/scans/new" className="text-cyan-300 hover:underline">
                  Run your first scan
                </Link>
                .
              </>
            ) : (
              <>No scans for the selected target.</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
