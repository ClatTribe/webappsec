import Link from 'next/link';
import { Plus, Activity, CheckCircle2, XCircle, Pause, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import type { ScanStatus } from '@/lib/supabase/types';

const STATUS_THEME: Record<ScanStatus, { Icon: LucideIcon; color: string; tag: string }> = {
  queued: { Icon: Pause, color: 'text-neutral-400', tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
  running: { Icon: Activity, color: 'text-blue-400', tag: 'bg-blue-500/15 text-blue-200 ring-blue-500/30' },
  completed: { Icon: CheckCircle2, color: 'text-emerald-400', tag: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' },
  failed: { Icon: XCircle, color: 'text-red-400', tag: 'bg-red-500/15 text-red-200 ring-red-500/30' },
  cancelled: { Icon: XCircle, color: 'text-neutral-500', tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
};

export default async function ScansListPage() {
  const supabase = createClient();
  const { data: scans } = await supabase
    .from('scans')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Scans</h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            Every scan run by your organization. Click a row to see findings and the live timeline.
          </p>
        </div>
        <Link
          href="/scans/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md hover:shadow-white/15"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New scan
        </Link>
      </header>

      <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
        {scans?.length ? (
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800/80 bg-neutral-900/40">
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-neutral-500">
                <th className="px-5 py-3 font-semibold">Run</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Mode</th>
                <th className="px-5 py-3 font-semibold">Cost</th>
                <th className="px-5 py-3 font-semibold">Started</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {scans.map((scan) => {
                const theme = STATUS_THEME[scan.status as ScanStatus];
                const Icon = theme.Icon;
                return (
                  <tr key={scan.id} className="group transition-colors hover:bg-neutral-900/40">
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
                      {scan.started_at
                        ? new Date(scan.started_at).toLocaleString()
                        : <span className="text-neutral-600">—</span>}
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
            No scans yet.{' '}
            <Link href="/scans/new" className="text-cyan-300 hover:underline">
              Run your first scan
            </Link>
            .
          </div>
        )}
      </div>
    </div>
  );
}
