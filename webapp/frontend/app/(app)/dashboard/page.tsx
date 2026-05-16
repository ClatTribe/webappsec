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
  AlertTriangle,
  Clock,
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

  // Phase B #5 — regressions: findings whose `finding_occurrences`
  // ledger shows a `reopened=true` row in the last 7 days, AND the
  // current finding row is open. That's the canonical "this finding
  // was fixed and came back" signal. The data has been wired since
  // migration 017 — we just never surfaced it. We fetch a count for
  // the dashboard tile + the most recent 5 for the regression list.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: recentScans },
    { count: openFindings },
    { data: integrations },
    { data: regressionsData },
    { count: expiringAcceptanceCount },
  ] = await Promise.all([
    supabase.from('scans').select('*').order('created_at', { ascending: false }).limit(5),
    supabase
      .from('findings')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open'),
    supabase.from('integrations').select('id, type, name').eq('status', 'active').limit(20),
    supabase
      .from('finding_occurrences')
      .select(
        'id, seen_at, reopened, finding_id, findings!inner(id, title, severity, status, target_id, targets(name))',
      )
      .eq('reopened', true)
      .gte('seen_at', sevenDaysAgo)
      .order('seen_at', { ascending: false })
      .limit(10),
    // Phase B #7 — risk-acceptance exceptions expiring in the next 14
    // days. Surfaced so a team doesn't get caught off-guard by a
    // tombstone re-opening at the wrong moment.
    supabase
      .from('findings')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'wont_fix')
      .not('risk_acceptance_expires_at', 'is', null)
      .lt(
        'risk_acceptance_expires_at',
        new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      ),
  ]);
  // De-dup regressions by finding_id (a finding can have multiple
  // reopened occurrences across scans within the window).
  const regressions: Array<{
    finding_id: string;
    seen_at: string;
    title: string | null;
    severity: string | null;
    status: string | null;
    target_name: string | null;
  }> = [];
  const seenFindingIds = new Set<string>();
  // The supabase-types stub claims `findings` is an array (because
  // it generates from FK metadata), but the !inner join returns a
  // single object. Cast through `unknown` to keep the strict-type
  // generator happy without losing per-field safety inside this loop.
  type RegressionRow = {
    finding_id: string;
    seen_at: string;
    findings: {
      id: string;
      title: string | null;
      severity: string | null;
      status: string | null;
      targets?: { name: string | null } | null;
    } | null;
  };
  for (const row of (regressionsData ?? []) as unknown as RegressionRow[]) {
    if (!row.findings || seenFindingIds.has(row.finding_id)) continue;
    seenFindingIds.add(row.finding_id);
    if (row.findings.status !== 'open') continue;
    regressions.push({
      finding_id: row.finding_id,
      seen_at: row.seen_at,
      title: row.findings.title,
      severity: row.findings.severity,
      status: row.findings.status,
      target_name: row.findings.targets?.name ?? null,
    });
  }

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

      {/* Phase B #5 — regression alerts. Renders only when reopened
          findings exist; silently absent on healthy dashboards. The
          per-finding link deep-jumps to the finding card on /findings
          for re-triage. */}
      {regressions.length > 0 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-rose-200">
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} />
              Regressions in the last 7 days
            </h2>
            <span className="text-[11px] text-neutral-500">
              Findings that were fixed or dismissed and have returned.
            </span>
          </div>
          <ul className="overflow-hidden rounded-xl border border-rose-500/30 bg-rose-500/[0.04] divide-y divide-rose-500/20">
            {regressions.slice(0, 5).map((r) => (
              <li key={r.finding_id}>
                <Link
                  href={`/findings#finding-${r.finding_id}`}
                  className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-rose-500/[0.08]"
                >
                  <span className="mt-1 flex h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-neutral-100">
                      {r.title ?? '(untitled)'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-rose-200/80">
                      {r.severity}
                      {r.target_name ? ` · ${r.target_name}` : ''} · reopened{' '}
                      {new Date(r.seen_at).toLocaleDateString()}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Phase B #7 — expiring risk-acceptance reminder. Surfaces only
          when the org has wont_fix findings whose expiry is within 14
          days. Click-through goes to /findings filtered to wont_fix. */}
      {(expiringAcceptanceCount ?? 0) > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] px-4 py-3 text-[13px] text-amber-100">
          <Link
            href="/findings?status=wont_fix"
            className="inline-flex items-center gap-2 hover:underline"
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={2.5} />
            <strong className="font-semibold">{expiringAcceptanceCount}</strong>
            <span>
              accepted-risk finding{(expiringAcceptanceCount ?? 0) === 1 ? '' : 's'} expire within
              the next 14 days — review before they auto-reopen.
            </span>
          </Link>
        </section>
      )}

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
