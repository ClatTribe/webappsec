import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronRight,
  Code2,
  Globe,
  Folder,
  Network,
  Server,
  Plus,
  Activity,
  CheckCircle2,
  XCircle,
  Pause,
  ArrowRight,
  Zap,
  Clock,
  Eye,
  Ban,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import FindingCard from '@/components/finding/finding-card';
import type { Finding, ScanStatus, Target, TargetType } from '@/lib/supabase/types';

const TYPE_ICON: Record<TargetType, LucideIcon> = {
  repository: Code2,
  web_application: Globe,
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

interface Props {
  params: { id: string };
}

export default async function TargetDetailPage({ params }: Props) {
  const supabase = createClient();
  const { data: target } = await supabase
    .from('targets')
    .select('*')
    .eq('id', params.id)
    .single();
  if (!target) notFound();
  const t = target as Target;

  const [{ data: scans }, { data: findings }] = await Promise.all([
    supabase
      .from('scans')
      .select('*')
      .eq('target_id', t.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('findings')
      .select('*')
      .eq('target_id', t.id)
      .order('created_at', { ascending: false }),
  ]);

  const allFindings = (findings as Finding[]) ?? [];
  const open = allFindings.filter((f) => !RESOLVED.has(f.status));
  const fixNow = open.filter((f) => f.ai_assessment?.urgency === 'fix_now').length;
  const fixSoon = open.filter((f) => f.ai_assessment?.urgency === 'fix_soon').length;
  const monitor = open.filter((f) => f.ai_assessment?.urgency === 'monitor').length;
  const dismissed = open.filter((f) => f.ai_assessment?.urgency === 'dismiss').length;
  const resolved = allFindings.length - open.length;

  // Sort findings: AI urgency → severity → recency.
  const URGENCY_RANK: Record<string, number> = { fix_now: 0, fix_soon: 1, monitor: 2, dismiss: 3 };
  const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sortedFindings = [...allFindings].sort((a, b) => {
    const ra = URGENCY_RANK[a.ai_assessment?.urgency ?? 'monitor'];
    const rb = URGENCY_RANK[b.ai_assessment?.urgency ?? 'monitor'];
    if (ra !== rb) return ra - rb;
    return (SEV_RANK[a.severity] ?? 99) - (SEV_RANK[b.severity] ?? 99);
  });

  const TypeIcon = TYPE_ICON[t.type] ?? Server;

  return (
    <div className="space-y-8">
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
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
              <TypeIcon className="h-5 w-5" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight">{t.name}</h1>
              <div className="mt-1 flex items-center gap-2 text-xs">
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

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile label="Scans" value={scans?.length ?? 0} />
          <StatTile
            label="Fix now"
            value={fixNow}
            tone="red"
            Icon={Zap}
          />
          <StatTile
            label="Fix soon"
            value={fixSoon}
            tone="orange"
            Icon={Clock}
          />
          <StatTile
            label="Monitor"
            value={monitor}
            tone="amber"
            Icon={Eye}
          />
          <StatTile
            label="Resolved"
            value={resolved}
            tone="neutral"
            Icon={CheckCircle2}
          />
        </div>
      </header>

      {/* Findings */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Findings
          </h2>
          <span className="text-xs text-neutral-500">
            {allFindings.length} total · {open.length} open · {resolved} resolved
            {dismissed > 0 && ` · ${dismissed} AI-dismissed`}
          </span>
        </div>

        {sortedFindings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-10 text-center text-sm text-neutral-400">
            No findings yet — this target hasn&apos;t been scanned, or scans completed cleanly.
          </div>
        ) : (
          <div className="space-y-3">
            {sortedFindings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        )}
      </section>

      {/* Scan history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          Scan history
        </h2>
        {scans && scans.length > 0 ? (
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
                        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${theme.tag}`}
                      >
                        <Icon className="h-3 w-3" strokeWidth={2.5} />
                        {s.status}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-100 transition-colors group-hover:text-cyan-300">
                          {s.run_name}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
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
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-10 text-center text-sm text-neutral-400">
            No scans yet.{' '}
            <Link
              href={`/scans/new?target=${t.id}`}
              className="text-cyan-300 hover:underline"
            >
              Run the first one
            </Link>
            .
          </div>
        )}
      </section>
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
