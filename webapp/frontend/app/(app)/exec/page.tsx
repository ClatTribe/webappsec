import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Clock,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  Layers,
  FolderKanban,
  Activity,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Executive overview',
};

// Phase Wrapper-Gap #10 — CISO / exec rollup page.
//
// One-pager designed for board / board-prep / quarterly business
// review. Aggregates the data that already exists:
//   - compliance_snapshots → quarter-over-quarter readiness trend
//   - findings + targets    → open critical / high counts, recent
//                              fixes, risk-weighted by project
//                              criticality
//   - projects              → service-level inventory
//   - targets               → asset-level inventory
//
// No new schema. The page is server-rendered against existing tables
// + views so it's strictly a presentation layer.

interface ProjectSummary {
  project_id: string;
  slug: string;
  name: string;
  criticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4';
  target_count: number;
  open_critical: number;
  open_high: number;
  open_total: number;
}

interface Snapshot {
  framework: string;
  quarter: string;
  score: number;
}

interface TargetRow {
  id: string;
  type: string;
  status: string;
}

interface FindingRow {
  id: string;
  severity: string;
  status: string;
  resolved_at: string | null;
  triaged_at: string | null;
  created_at: string;
  target_id: string | null;
}

export default async function ExecRollupPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Pull everything in parallel — each query is RLS-scoped, no
  // explicit org filtering needed in the page.
  const [
    { data: projectsRaw },
    { data: snapshotsRaw },
    { data: targetsRaw },
    { data: findingsRaw },
  ] = await Promise.all([
    supabase
      .from('project_summary_v')
      .select('project_id, slug, name, criticality, target_count, open_critical, open_high, open_total')
      .is('archived_at', null),
    supabase
      .from('compliance_snapshots')
      .select('framework, quarter, score')
      .order('quarter', { ascending: true })
      .limit(64),
    supabase
      .from('targets')
      .select('id, type, status')
      .in('status', ['active', 'dormant']),
    supabase
      .from('findings')
      .select('id, severity, status, resolved_at, triaged_at, created_at, target_id')
      .order('created_at', { ascending: false })
      .limit(2000),
  ]);

  const projects = (projectsRaw ?? []) as ProjectSummary[];
  const snapshots = (snapshotsRaw ?? []) as Snapshot[];
  const targets = (targetsRaw ?? []) as TargetRow[];
  const findings = (findingsRaw ?? []) as FindingRow[];

  // ---- Derived headline stats ---------------------------------
  const openCritical = findings.filter(
    (f) => f.severity === 'critical' && f.status === 'open',
  ).length;
  const openHigh = findings.filter(
    (f) => f.severity === 'high' && f.status === 'open',
  ).length;
  const activeTargets = targets.filter((t) => t.status === 'active').length;
  const dormantTargets = targets.filter((t) => t.status === 'dormant').length;
  const tier1Projects = projects.filter((p) => p.criticality === 'tier_1').length;

  // ---- Last 30d resolution velocity ---------------------------
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const fixedLast30 = findings.filter((f) => {
    if (f.status !== 'fixed') return false;
    const ts = f.resolved_at ? Date.parse(f.resolved_at) : NaN;
    return Number.isFinite(ts) && ts >= thirtyDaysAgo;
  }).length;
  const createdLast30 = findings.filter(
    (f) => Date.parse(f.created_at) >= thirtyDaysAgo,
  ).length;
  const openedLast30Critical = findings.filter(
    (f) =>
      f.severity === 'critical' &&
      Date.parse(f.created_at) >= thirtyDaysAgo,
  ).length;

  // ---- Top risks: tier_1/2 projects with open critical/high ---
  const topRisks = projects
    .filter((p) => p.open_critical > 0 || p.open_high > 0)
    .map((p) => ({
      ...p,
      risk_score:
        criticalityWeight(p.criticality) * (p.open_critical * 10 + p.open_high * 3),
    }))
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 5);

  // ---- Coverage: target types in use vs. all 8 ---------------
  const typesInUse = new Set(targets.map((t) => t.type));
  const ALL_TYPES = [
    'repository',
    'web_application',
    'api',
    'cloud_account',
    'container_image',
    'domain',
    'ip_address',
    'local_code',
  ];
  const coverageGaps = ALL_TYPES.filter((t) => !typesInUse.has(t));

  // ---- Readiness trend per framework -------------------------
  // Group snapshots by framework, take last 4 quarters per framework.
  const byFw: Record<string, Snapshot[]> = {};
  for (const s of snapshots) {
    (byFw[s.framework] = byFw[s.framework] ?? []).push(s);
  }
  const frameworkTrends = Object.entries(byFw)
    .map(([fw, snaps]) => {
      const sorted = snaps.sort((a, b) => a.quarter.localeCompare(b.quarter));
      const tail = sorted.slice(-4);
      const latest = tail[tail.length - 1];
      const prev = tail.length > 1 ? tail[tail.length - 2] : null;
      return {
        framework: fw,
        snapshots: tail,
        latest_score: latest?.score ?? 0,
        delta: prev ? latest.score - prev.score : 0,
        prev_quarter: prev?.quarter ?? null,
      };
    })
    .sort((a, b) => b.latest_score - a.latest_score);

  return (
    <div className="max-w-6xl space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">
            Executive overview
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Board-ready summary of your security &amp; compliance posture. One
          screen, every framework, the top five things to talk about this
          quarter.
        </p>
      </header>

      {/* Headline row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeadlineStat
          icon={AlertCircle}
          tone={openCritical > 0 ? 'rose' : 'emerald'}
          label="Open critical"
          value={openCritical}
        />
        <HeadlineStat
          icon={AlertTriangle}
          tone={openHigh > 0 ? 'amber' : 'emerald'}
          label="Open high"
          value={openHigh}
        />
        <HeadlineStat
          icon={ShieldCheck}
          tone="cyan"
          label="Assets monitored"
          value={activeTargets}
        />
        <HeadlineStat
          icon={FolderKanban}
          tone="violet"
          label="Services tracked"
          value={projects.length}
          sub={`${tier1Projects} tier-1`}
        />
        <HeadlineStat
          icon={CheckCircle2}
          tone="emerald"
          label="Fixed (30d)"
          value={fixedLast30}
        />
        <HeadlineStat
          icon={Clock}
          tone="neutral"
          label="Dormant"
          value={dormantTargets}
        />
      </section>

      {/* 30-day activity story */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          <Activity className="h-3 w-3" strokeWidth={2.25} />
          Last 30 days
        </h2>
        <p className="mt-2 text-sm text-neutral-200">
          {fixedLast30 > openedLast30Critical ? (
            <>
              We resolved <strong className="text-emerald-300">{fixedLast30}</strong>{' '}
              finding{fixedLast30 === 1 ? '' : 's'} and surfaced{' '}
              <strong>{createdLast30}</strong> new ones ({openedLast30Critical}{' '}
              critical). Net direction: <strong className="text-emerald-300">improving</strong>.
            </>
          ) : openedLast30Critical > 0 ? (
            <>
              <strong className="text-rose-300">{openedLast30Critical}</strong> new
              critical finding{openedLast30Critical === 1 ? '' : 's'} surfaced;{' '}
              {fixedLast30} fix{fixedLast30 === 1 ? '' : 'es'} shipped. Net direction:{' '}
              <strong className="text-rose-300">needs attention</strong>.
            </>
          ) : (
            <>
              Quiet month — {createdLast30} new finding{createdLast30 === 1 ? '' : 's'},{' '}
              {fixedLast30} resolved. Net direction:{' '}
              <strong className="text-neutral-200">steady</strong>.
            </>
          )}
        </p>
      </section>

      {/* Framework readiness trend */}
      {frameworkTrends.length > 0 && (
        <section>
          <h2 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <TrendingUp className="h-3 w-3" strokeWidth={2.25} />
            Compliance readiness · last 4 quarters
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {frameworkTrends.map((f) => (
              <FrameworkTrendCard key={f.framework} {...f} />
            ))}
          </div>
        </section>
      )}

      {/* Top risks */}
      {topRisks.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Top risks this quarter
          </h2>
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {topRisks.map((p, i) => (
              <Link
                key={p.project_id}
                href={`/projects/${p.slug}`}
                className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-900/50 ${
                  i < topRisks.length - 1 ? 'border-b border-neutral-800/60' : ''
                }`}
              >
                <CriticalityChip criticality={p.criticality} />
                <div className="min-w-0">
                  <div className="text-sm text-neutral-100">{p.name}</div>
                  <div className="text-[10.5px] text-neutral-500">
                    {p.target_count} target{p.target_count === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {p.open_critical > 0 && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-rose-300">
                      {p.open_critical} crit
                    </span>
                  )}
                  {p.open_high > 0 && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-300">
                      {p.open_high} high
                    </span>
                  )}
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Coverage gaps */}
      {coverageGaps.length > 0 && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
          <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <Layers className="h-3 w-3" strokeWidth={2.25} />
            Coverage gaps
          </h2>
          <p className="mt-2 text-sm text-neutral-300">
            {coverageGaps.length} attack surface
            {coverageGaps.length === 1 ? '' : 's'} not yet monitored:
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {coverageGaps.map((t) => (
              <span
                key={t}
                className="rounded bg-neutral-800/70 px-2 py-1 font-mono text-[11px] text-neutral-300"
              >
                {t}
              </span>
            ))}
          </div>
          <Link
            href="/assets/new"
            className="mt-3 inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline"
          >
            Add a target
            <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
          </Link>
        </section>
      )}

      {/* Footer ribbon — quick links */}
      <section className="grid gap-3 sm:grid-cols-3">
        <QuickLink
          href="/projects"
          icon={FolderKanban}
          title="Projects"
          subtitle={`${projects.length} services · ${tier1Projects} tier-1`}
        />
        <QuickLink
          href="/compliance"
          icon={ShieldCheck}
          title="Compliance"
          subtitle="Per-control evidence · auditor portal"
        />
        <QuickLink
          href="/settings"
          icon={Sparkles}
          title="Share with the board"
          subtitle="Mint a read-only auditor portal link"
        />
      </section>
    </div>
  );
}

function criticalityWeight(c: ProjectSummary['criticality']): number {
  return c === 'tier_1' ? 4 : c === 'tier_2' ? 2 : c === 'tier_3' ? 1 : 0.5;
}

function HeadlineStat({
  icon: Icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  tone: 'rose' | 'amber' | 'cyan' | 'violet' | 'emerald' | 'neutral';
  label: string;
  value: number;
  sub?: string;
}) {
  const colors: Record<typeof tone, string> = {
    rose: 'text-rose-300',
    amber: 'text-amber-300',
    cyan: 'text-cyan-300',
    violet: 'text-violet-300',
    emerald: 'text-emerald-300',
    neutral: 'text-neutral-300',
  };
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3">
      <Icon className={`h-3.5 w-3.5 ${colors[tone]}`} strokeWidth={2.25} />
      <div
        className={`mt-2 text-2xl font-semibold ${
          value > 0 ? colors[tone] : 'text-neutral-200'
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-neutral-500">{sub}</div>}
    </div>
  );
}

function FrameworkTrendCard({
  framework,
  snapshots,
  latest_score,
  delta,
  prev_quarter,
}: {
  framework: string;
  snapshots: Snapshot[];
  latest_score: number;
  delta: number;
  prev_quarter: string | null;
}) {
  const max = Math.max(100, ...snapshots.map((s) => s.score));
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] text-neutral-300">
          {framework}
        </span>
        <span className="text-2xl font-semibold text-neutral-100">
          {latest_score}
        </span>
      </div>
      {prev_quarter && (
        <div className="text-[9.5px]">
          {delta >= 0 ? (
            <span className="inline-flex items-center gap-1 text-emerald-300">
              <TrendingUp className="h-2.5 w-2.5" />▲ {Math.abs(delta)} vs{' '}
              {prev_quarter}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-rose-300">
              <TrendingDown className="h-2.5 w-2.5" />▼ {Math.abs(delta)} vs{' '}
              {prev_quarter}
            </span>
          )}
        </div>
      )}
      <div className="mt-2 flex items-end gap-1">
        {snapshots.map((s) => (
          <div key={s.quarter} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-cyan-500/30"
              style={{ height: `${Math.max(3, (s.score / max) * 28)}px` }}
              title={`${s.quarter}: ${s.score}`}
            />
            <span className="font-mono text-[8.5px] text-neutral-500">
              {s.quarter.replace(/^\d{2}/, '')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CriticalityChip({
  criticality,
}: {
  criticality: ProjectSummary['criticality'];
}) {
  const t: Record<ProjectSummary['criticality'], string> = {
    tier_1: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
    tier_2: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    tier_3: 'bg-cyan-500/10 text-cyan-300 ring-cyan-500/30',
    tier_4: 'bg-neutral-700/30 text-neutral-400 ring-neutral-600/40',
  };
  return (
    <span
      className={`inline-flex flex-shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${t[criticality]}`}
    >
      {criticality.replace('_', ' ')}
    </span>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  subtitle,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <Icon className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
          {title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-neutral-500">
          {subtitle}
        </div>
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-neutral-500 transition-colors group-hover:text-cyan-300" />
    </Link>
  );
}
