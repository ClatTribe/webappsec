import Link from 'next/link';
import {
  ScanLine,
  ShieldAlert,
  Plug,
  Plus,
  ArrowRight,
  Activity,
  CheckCircle2,
  XCircle,
  Pause,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import type { ScanStatus } from '@/lib/supabase/types';

const STATUS_DOT: Record<ScanStatus, { color: string; Icon: LucideIcon }> = {
  queued: { color: 'text-neutral-400', Icon: Pause },
  running: { color: 'text-blue-400', Icon: Activity },
  completed: { color: 'text-emerald-400', Icon: CheckCircle2 },
  failed: { color: 'text-red-400', Icon: XCircle },
  cancelled: { color: 'text-neutral-500', Icon: XCircle },
};

export default async function DashboardPage() {
  const supabase = createClient();

  const [{ data: recentScans }, { count: openFindings }, { data: integrations }] =
    await Promise.all([
      supabase.from('scans').select('*').order('created_at', { ascending: false }).limit(5),
      supabase
        .from('findings')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'open'),
      supabase.from('integrations').select('id, type, name').eq('status', 'active').limit(20),
    ]);

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            Overview of recent scans, open findings, and connected integrations.
          </p>
        </div>
        <Link
          href="/scans/new"
          className="group inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:from-neutral-50 hover:shadow-md hover:shadow-white/15"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New scan
        </Link>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Recent scans"
          value={recentScans?.length ?? 0}
          href="/scans"
          Icon={ScanLine}
          tone="cyan"
        />
        <StatCard
          label="Open findings"
          value={openFindings ?? 0}
          href="/findings"
          Icon={ShieldAlert}
          tone="orange"
          highlight={(openFindings ?? 0) > 0}
        />
        <StatCard
          label="Active integrations"
          value={integrations?.length ?? 0}
          href="/integrations"
          Icon={Plug}
          tone="violet"
        />
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Recent scans
          </h2>
          <Link
            href="/scans"
            className="text-xs text-neutral-400 transition-colors hover:text-cyan-300"
          >
            View all →
          </Link>
        </div>

        <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
          {recentScans?.length ? (
            <ul className="divide-y divide-neutral-800/60">
              {recentScans.map((scan) => {
                const dot = STATUS_DOT[scan.status as ScanStatus];
                const DotIcon = dot.Icon;
                return (
                  <li key={scan.id}>
                    <Link
                      href={`/scans/${scan.id}`}
                      className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-neutral-900/50"
                    >
                      <DotIcon className={`h-4 w-4 flex-shrink-0 ${dot.color}`} strokeWidth={2} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-100">
                          {scan.run_name}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                          <span>{scan.scan_mode}</span>
                          <span>·</span>
                          <span>{scan.status}</span>
                          {scan.started_at && (
                            <>
                              <span>·</span>
                              <span>{new Date(scan.started_at).toLocaleString()}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 flex-shrink-0 text-neutral-600 transition-all group-hover:translate-x-0.5 group-hover:text-neutral-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-neutral-500">
              No scans yet.{' '}
              <Link href="/scans/new" className="text-cyan-300 hover:underline">
                Run your first scan
              </Link>
              .
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const TONE: Record<string, { bg: string; ring: string; text: string }> = {
  cyan: {
    bg: 'from-cyan-500/15 to-cyan-500/0',
    ring: 'ring-cyan-500/20',
    text: 'text-cyan-300',
  },
  orange: {
    bg: 'from-orange-500/15 to-orange-500/0',
    ring: 'ring-orange-500/25',
    text: 'text-orange-300',
  },
  violet: {
    bg: 'from-violet-500/15 to-violet-500/0',
    ring: 'ring-violet-500/20',
    text: 'text-violet-300',
  },
};

function StatCard({
  label,
  value,
  href,
  Icon,
  tone,
  highlight = false,
}: {
  label: string;
  value: number;
  href: string;
  Icon: LucideIcon;
  tone: keyof typeof TONE;
  highlight?: boolean;
}) {
  const t = TONE[tone];
  return (
    <Link
      href={href}
      className={`group relative overflow-hidden rounded-xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} p-5 ring-1 ${t.ring} transition-all hover:border-neutral-700 hover:shadow-lg hover:shadow-white/5`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            {label}
          </div>
          <div
            className={`mt-2 text-3xl font-semibold tracking-tight ${highlight ? t.text : 'text-neutral-100'}`}
          >
            {value}
          </div>
        </div>
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-900/60 ${t.text} ring-1 ring-inset ring-white/5`}
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
      </div>
    </Link>
  );
}
