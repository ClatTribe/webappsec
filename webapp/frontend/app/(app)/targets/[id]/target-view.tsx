'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  Code2,
  Globe,
  Folder,
  Network,
  Server,
  Plus,
  Plug,
  Container,
  Activity,
  CheckCircle2,
  XCircle,
  Pause,
  ArrowRight,
  Zap,
  Clock,
  Eye,
  ShieldAlert,
  ScanLine,
  LayoutDashboard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import FindingCard from '@/components/finding/finding-card';
import DiscoveriesPanel from '@/components/target/discoveries-panel';
import type { Finding, Scan, ScanStatus, Target, TargetType } from '@/lib/supabase/types';

const TYPE_ICON: Record<TargetType, LucideIcon> = {
  repository: Code2,
  web_application: Globe,
  api: Plug,
  container_image: Container,
  domain: Globe,
  ip_address: Network,
  local_code: Folder,
};

const STATUS_THEME: Record<ScanStatus, { Icon: LucideIcon; tag: string }> = {
  queued: { Icon: Pause, tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
  running: { Icon: Activity, tag: 'bg-blue-500/15 text-blue-200 ring-blue-500/30' },
  completed: { Icon: CheckCircle2, tag: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' },
  failed: { Icon: XCircle, tag: 'bg-red-500/15 text-red-200 ring-red-500/30' },
  cancelled: { Icon: XCircle, tag: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' },
};

const RESOLVED = new Set(['fixed', 'false_positive', 'wont_fix']);
const URGENCY_RANK: Record<string, number> = { fix_now: 0, fix_soon: 1, monitor: 2, dismiss: 3 };
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

type TabId = 'overview' | 'findings' | 'scans';

const TABS: { id: TabId; label: string; Icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'findings', label: 'Findings', Icon: ShieldAlert },
  { id: 'scans', label: 'Scans', Icon: ScanLine },
];

interface Props {
  target: Target;
  scans: Scan[];
  findings: Finding[];
  initialTab?: string;
}

export default function TargetView({ target: t, scans, findings, initialTab }: Props) {
  const [tab, setTab] = useState<TabId>(
    (TABS.find((x) => x.id === initialTab)?.id as TabId | undefined) ?? 'overview',
  );

  const open = findings.filter((f) => !RESOLVED.has(f.status));
  const fixNow = open.filter((f) => f.ai_assessment?.urgency === 'fix_now').length;
  const fixSoon = open.filter((f) => f.ai_assessment?.urgency === 'fix_soon').length;
  const monitor = open.filter((f) => f.ai_assessment?.urgency === 'monitor').length;
  const dismissed = open.filter((f) => f.ai_assessment?.urgency === 'dismiss').length;
  const resolved = findings.length - open.length;

  const sortedFindings = [...findings].sort((a, b) => {
    const ra = URGENCY_RANK[a.ai_assessment?.urgency ?? 'monitor'];
    const rb = URGENCY_RANK[b.ai_assessment?.urgency ?? 'monitor'];
    if (ra !== rb) return ra - rb;
    return (SEV_RANK[a.severity] ?? 99) - (SEV_RANK[b.severity] ?? 99);
  });

  const TypeIcon = TYPE_ICON[t.type] ?? Server;
  const lastScan = scans[0];

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/targets" className="transition-colors hover:text-neutral-300">
          Targets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="truncate text-neutral-300">{t.name}</span>
      </nav>

      <header className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
              <TypeIcon className="h-5 w-5" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight">{t.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                <code className="truncate rounded bg-neutral-900 px-2 py-0.5 font-mono text-neutral-300 ring-1 ring-neutral-800">
                  {t.value}
                </code>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-neutral-400">
                  {t.type}
                </span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                  {t.scan_frequency}
                </span>
              </div>
              {t.description && (
                <p className="mt-2 max-w-2xl text-sm text-neutral-300">{t.description}</p>
              )}
            </div>
          </div>
          <Link
            href={`/scans/new?target=${t.id}`}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            New scan
          </Link>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-neutral-800">
        {TABS.map((x) => {
          const TabIcon = x.Icon;
          const active = tab === x.id;
          const count =
            x.id === 'findings' ? findings.length : x.id === 'scans' ? scans.length : null;
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => setTab(x.id)}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-cyan-500 text-neutral-50'
                  : 'border-transparent text-neutral-400 hover:text-neutral-100'
              }`}
            >
              <TabIcon className="h-3.5 w-3.5" strokeWidth={2.25} />
              {x.label}
              {count !== null && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    active ? 'bg-cyan-500/15 text-cyan-200' : 'bg-neutral-800 text-neutral-400'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* OVERVIEW */}
      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatTile label="Scans" value={scans.length} />
            <StatTile label="Fix now" value={fixNow} tone="red" Icon={Zap} />
            <StatTile label="Fix soon" value={fixSoon} tone="orange" Icon={Clock} />
            <StatTile label="Monitor" value={monitor} tone="amber" Icon={Eye} />
            <StatTile label="Resolved" value={resolved} tone="neutral" Icon={CheckCircle2} />
          </div>

          {/* Subdomain auto-discovery — only renders for domain targets.
              When auto_discover is off (default) and no historical data
              exists, the panel shows an opt-in CTA. */}
          <DiscoveriesPanel
            targetId={t.id}
            targetType={t.type}
            autoDiscover={t.auto_discover ?? false}
          />

          {/* Top 3 most urgent findings */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
                Top findings
              </h2>
              {findings.length > 3 && (
                <button
                  type="button"
                  onClick={() => setTab('findings')}
                  className="text-xs text-cyan-300 hover:underline"
                >
                  View all {findings.length} →
                </button>
              )}
            </div>
            {sortedFindings.length === 0 ? (
              <EmptyHint
                Icon={ShieldAlert}
                title="No findings yet"
                hint="Run a scan to populate this target."
                actionHref={`/scans/new?target=${t.id}`}
                actionLabel="Run a scan"
              />
            ) : (
              <div className="space-y-3">
                {sortedFindings.slice(0, 3).map((f) => (
                  <FindingCard key={f.id} finding={f} />
                ))}
              </div>
            )}
          </section>

          {/* Recent scans */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
                Recent scans
              </h2>
              {scans.length > 3 && (
                <button
                  type="button"
                  onClick={() => setTab('scans')}
                  className="text-xs text-cyan-300 hover:underline"
                >
                  View all {scans.length} →
                </button>
              )}
            </div>
            {scans.length === 0 ? (
              <EmptyHint
                Icon={ScanLine}
                title="No scans yet"
                hint="This target hasn't been scanned."
                actionHref={`/scans/new?target=${t.id}`}
                actionLabel="Run the first scan"
              />
            ) : (
              <ScanList scans={scans.slice(0, 3)} />
            )}
            {lastScan && (
              <p className="px-1 text-[11px] text-neutral-500">
                Last activity: {new Date(lastScan.created_at).toLocaleString()}
              </p>
            )}
          </section>
        </div>
      )}

      {/* FINDINGS TAB */}
      {tab === 'findings' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-neutral-400">
              {findings.length} total · {open.length} open · {resolved} resolved
              {dismissed > 0 && ` · ${dismissed} AI-dismissed`}
            </span>
          </div>
          {sortedFindings.length === 0 ? (
            <EmptyHint
              Icon={ShieldAlert}
              title="No findings yet"
              hint="Run a scan to populate this target."
              actionHref={`/scans/new?target=${t.id}`}
              actionLabel="Run a scan"
            />
          ) : (
            <div className="space-y-3">
              {sortedFindings.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* SCANS TAB */}
      {tab === 'scans' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">
              {scans.length} scan{scans.length === 1 ? '' : 's'} for this target
            </span>
          </div>
          {scans.length === 0 ? (
            <EmptyHint
              Icon={ScanLine}
              title="No scans yet"
              hint="Run a scan to start finding issues."
              actionHref={`/scans/new?target=${t.id}`}
              actionLabel="Run the first scan"
            />
          ) : (
            <ScanList scans={scans} />
          )}
        </section>
      )}
    </div>
  );
}

// ---- Sub-components ----

function ScanList({ scans }: { scans: Scan[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
      <ul className="divide-y divide-neutral-800/60">
        {scans.map((s) => {
          const theme = STATUS_THEME[s.status as ScanStatus];
          const Icon = theme.Icon;
          return (
            <li key={s.id}>
              <Link
                href={`/scans/${s.id}`}
                className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-neutral-900/50"
              >
                <span
                  className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${theme.tag}`}
                >
                  <Icon className="h-3 w-3" strokeWidth={2.5} />
                  {s.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-100 transition-colors group-hover:text-cyan-300">
                    {s.run_name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-500">
                    <span>{s.scan_mode}</span>
                    {s.total_cost != null && Number(s.total_cost) > 0 && (
                      <>
                        <span>·</span>
                        <span>${Number(s.total_cost).toFixed(2)}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>
                      {s.started_at
                        ? new Date(s.started_at).toLocaleString()
                        : new Date(s.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 flex-shrink-0 text-neutral-600 transition-all group-hover:translate-x-0.5 group-hover:text-neutral-300" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TONE: Record<string, string> = {
  red: 'border-red-500/30 bg-red-500/10 text-red-200',
  orange: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  neutral: 'border-neutral-800 bg-neutral-900/30 text-neutral-200',
};

function StatTile({
  label,
  value,
  tone = 'neutral',
  Icon,
}: {
  label: string;
  value: number;
  tone?: keyof typeof TONE;
  Icon?: LucideIcon;
}) {
  const t = TONE[tone];
  return (
    <div className={`rounded-xl border ${t} px-4 py-3`}>
      <div className="flex items-start justify-between">
        <div>
          <div className={`text-2xl font-semibold ${value > 0 ? '' : 'text-neutral-600'}`}>
            {value}
          </div>
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-300">
            {label}
          </div>
        </div>
        {Icon && <Icon className="h-4 w-4 opacity-70" strokeWidth={2.25} />}
      </div>
    </div>
  );
}

function EmptyHint({
  Icon,
  title,
  hint,
  actionHref,
  actionLabel,
}: {
  Icon: LucideIcon;
  title: string;
  hint: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-10 text-center">
      <Icon className="mx-auto h-6 w-6 text-neutral-500" strokeWidth={1.75} />
      <p className="mt-3 text-sm text-neutral-300">{title}</p>
      <p className="mt-1 text-xs text-neutral-500">{hint}</p>
      <Link
        href={actionHref}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-neutral-200"
      >
        <Plus className="h-3.5 w-3.5" />
        {actionLabel}
      </Link>
    </div>
  );
}
