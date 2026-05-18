import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  GitBranch,
  Globe,
  Cloud,
  Plug,
  ShieldCheck,
  Sparkles,
  Activity,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Home',
};

// Adaptive Home — replaces the static /dashboard. Two distinct states:
//
//   Empty (no integrations connected):
//     Big "connect your first system" CTA with three high-conversion
//     starting points (GitHub / web URL / AWS). Skips the secondary
//     onboarding noise.
//
//   Populated:
//     Today's inbox + posture snapshot. The first thing the user
//     sees is "what needs my decision today" — not a chart deck.
//
// Frequency ordering throughout: most-actionable thing on top.

interface CountRow {
  count: number | null;
}

interface FindingRow {
  id: string;
  title: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | null;
  status: string;
  created_at: string;
}

interface ScanRow {
  id: string;
  status: string;
  run_name: string | null;
  created_at: string;
  finished_at: string | null;
}

export default async function HomePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Coverage signal: do we have ANY connected integration at all?
  // Used to pick empty-state vs populated.
  const { count: integrationCount } = (await supabase
    .from('integrations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')) as unknown as CountRow;

  if ((integrationCount ?? 0) === 0) {
    return <EmptyHome userName={user.email?.split('@')[0] ?? 'there'} />;
  }

  return <PopulatedHome />;
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function EmptyHome({ userName }: { userName: string }) {
  const starters: { Icon: LucideIcon; label: string; blurb: string; href: string }[] = [
    {
      Icon: GitBranch,
      label: 'Connect GitHub',
      blurb:
        'We scan every repo for code bugs, risky dependencies, and leaked secrets. The repos themselves we discover for you.',
      href: '/integrations/new/github',
    },
    {
      Icon: Globe,
      label: 'Add a web app URL',
      blurb:
        'We drive a real browser against your live site and try to actually exploit anything we find before flagging it.',
      href: '/assets/new/web',
    },
    {
      Icon: Cloud,
      label: 'Connect AWS',
      blurb:
        'We check who has admin access, find publicly-exposed assets, and map the chain an attacker would follow into your data.',
      href: '/integrations/new/aws',
    },
  ];

  return (
    <div className="max-w-4xl space-y-10">
      <header className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </span>
          Welcome
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Hey {userName}.
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-neutral-400">
          TensorShield watches three things for most teams. Pick one to start —
          each takes about a minute.
        </p>
      </header>

      <section className="space-y-3">
        {starters.map((s, i) => (
          <Link
            key={s.href}
            href={s.href}
            className="group flex items-start gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5 transition-all hover:-translate-y-0.5 hover:border-cyan-500/40 hover:bg-neutral-900/50"
          >
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-200 ring-1 ring-inset ring-white/5">
              <s.Icon className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-white">
                  {s.label}
                </span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-neutral-500">
                  step {i + 1}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-400">{s.blurb}</p>
            </div>
            <ArrowRight
              className="mt-1 h-4 w-4 flex-shrink-0 text-neutral-500 transition-all group-hover:translate-x-1 group-hover:text-cyan-300"
              strokeWidth={2}
            />
          </Link>
        ))}
      </section>

      <p className="text-xs text-neutral-500">
        Already have a CMDB, Terraform state, or spreadsheet of assets? Use{' '}
        <Link href="/assets" className="text-cyan-300 hover:underline">
          Assets → Add
        </Link>{' '}
        for bulk paths.
      </p>
    </div>
  );
}

// =============================================================================
// POPULATED STATE
// =============================================================================

async function PopulatedHome() {
  const supabase = createClient();

  // Three signals to surface:
  //   1. Open critical / high findings the user should triage today
  //   2. Recent scans (last 24h) — proves the system is alive
  //   3. Asset coverage by type — quick "what TensorShield sees" view
  const [
    { data: criticalFindings },
    { data: recentScans },
    { count: targetCount },
    { count: openFindings },
    { count: integrations },
  ] = await Promise.all([
    supabase
      .from('findings')
      .select('id, title, severity, status, created_at')
      .eq('status', 'open')
      .in('severity', ['critical', 'high'])
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('scans')
      .select('id, status, run_name, created_at, finished_at')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('targets')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('findings')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open'),
    supabase
      .from('integrations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
  ]);

  const criticalRows = (criticalFindings ?? []) as FindingRow[];
  const scanRows = (recentScans ?? []) as ScanRow[];
  const todayScans = scanRows.length;
  const todayScansFailed = scanRows.filter((s) => s.status === 'failed').length;
  const todayScansClean = scanRows.filter(
    (s) => s.status === 'completed' && s.finished_at,
  ).length;

  return (
    <div className="max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Home</h1>
        <p className="text-sm text-neutral-400">
          Today, at a glance. The things needing your decision are at the top.
        </p>
      </header>

      {/* TODAY — the inbox */}
      <section>
        <h2 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          <AlertCircle className="h-3 w-3" strokeWidth={2.5} />
          Needs your decision · {criticalRows.length}
        </h2>
        {criticalRows.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-5">
            <p className="inline-flex items-center gap-2 text-sm text-emerald-200">
              <CheckCircle2 className="h-4 w-4" strokeWidth={2.25} />
              No open critical or high findings. Quiet day.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/30">
            {criticalRows.map((f, i) => (
              <Link
                key={f.id}
                href={`/findings/${f.id}`}
                className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-900/50 ${
                  i < criticalRows.length - 1 ? 'border-b border-neutral-800/60' : ''
                }`}
              >
                <SeverityChip severity={f.severity ?? 'info'} />
                <span className="truncate text-sm text-neutral-100">
                  {f.title ?? '(untitled finding)'}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* SNAPSHOT — coverage + posture chips */}
      <section className="grid gap-3 sm:grid-cols-4">
        <SnapshotCard
          Icon={ShieldCheck}
          label="Assets monitored"
          value={targetCount ?? 0}
          href="/assets"
        />
        <SnapshotCard
          Icon={AlertTriangle}
          label="Open findings"
          value={openFindings ?? 0}
          tone={(openFindings ?? 0) > 0 ? 'amber' : 'emerald'}
          href="/findings"
        />
        <SnapshotCard
          Icon={Plug}
          label="Integrations"
          value={integrations ?? 0}
          href="/integrations"
        />
        <SnapshotCard
          Icon={Activity}
          label="Scans (24h)"
          value={todayScans}
          sub={
            todayScans > 0
              ? `${todayScansClean} clean · ${todayScansFailed} failed`
              : 'idle'
          }
        />
      </section>

      {/* TODAY'S ACTIVITY — engine alive signal */}
      {scanRows.length > 0 && (
        <section>
          <h2 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <Clock className="h-3 w-3" strokeWidth={2.5} />
            Recent activity
          </h2>
          <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/30">
            {scanRows.map((s, i) => (
              <Link
                key={s.id}
                href={`/scans/${s.id}`}
                className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-900/50 ${
                  i < scanRows.length - 1 ? 'border-b border-neutral-800/60' : ''
                }`}
              >
                <ScanStatusDot status={s.status} />
                <span className="truncate text-[12.5px] text-neutral-200">
                  {s.run_name ?? '(unnamed scan)'}
                </span>
                <span className="text-[10.5px] text-neutral-500">
                  {new Date(s.created_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* SECONDARY — only surfaces if useful */}
      <section className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/compliance"
          className="group flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-all hover:-translate-y-0.5 hover:border-amber-500/40"
        >
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-200 ring-1 ring-inset ring-amber-500/20">
            <TrendingUp className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">
              See compliance status
            </div>
            <p className="mt-0.5 text-[11.5px] text-neutral-400">
              Control-by-control evidence across SOC 2, ISO 27001, PCI DSS, HIPAA,
              and NIST. The portal you share with auditors lives here too.
            </p>
          </div>
          <ChevronRight
            className="ml-auto h-3.5 w-3.5 text-neutral-500 transition-colors group-hover:text-amber-300"
            strokeWidth={2.25}
          />
        </Link>
        <Link
          href="/chat"
          className="group flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-all hover:-translate-y-0.5 hover:border-cyan-500/40"
        >
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-200 ring-1 ring-inset ring-cyan-500/20">
            <Sparkles className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">
              Ask TensorShield
            </div>
            <p className="mt-0.5 text-[11.5px] text-neutral-400">
              &ldquo;Am I SOC 2 ready?&rdquo; · &ldquo;What was that server-side bug we found last quarter?&rdquo;
            </p>
          </div>
          <ChevronRight
            className="ml-auto h-3.5 w-3.5 text-neutral-500 transition-colors group-hover:text-cyan-300"
            strokeWidth={2.25}
          />
        </Link>
      </section>
    </div>
  );
}

function SnapshotCard({
  Icon,
  label,
  value,
  tone = 'neutral',
  sub,
  href,
}: {
  Icon: LucideIcon;
  label: string;
  value: number;
  tone?: 'amber' | 'rose' | 'emerald' | 'neutral';
  sub?: string;
  href?: string;
}) {
  const color = {
    amber: 'text-amber-300',
    rose: 'text-rose-300',
    emerald: 'text-emerald-300',
    neutral: 'text-neutral-200',
  }[tone];
  const inner = (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-neutral-700">
      <Icon className={`h-3.5 w-3.5 ${color}`} strokeWidth={2.25} />
      <div className={`mt-2 text-2xl font-semibold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-neutral-500">{sub}</div>}
    </div>
  );
  if (href) {
    return <Link href={href}>{inner}</Link>;
  }
  return inner;
}

function SeverityChip({ severity }: { severity: string }) {
  const theme: Record<string, string> = {
    critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    high: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    medium: 'bg-yellow-500/15 text-yellow-200 ring-yellow-500/30',
    low: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    info: 'bg-neutral-700/40 text-neutral-400 ring-neutral-600/40',
  };
  return (
    <span
      className={`inline-flex rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${
        theme[severity] ?? theme.info
      }`}
    >
      {severity}
    </span>
  );
}

function ScanStatusDot({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-400'
      : status === 'failed'
        ? 'bg-rose-400'
        : status === 'running'
          ? 'bg-cyan-400'
          : 'bg-neutral-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />;
}
