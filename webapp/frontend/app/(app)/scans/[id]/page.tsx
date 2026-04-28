import { notFound } from 'next/navigation';
import {
  ChevronRight,
  Target,
  Cpu,
  ArrowDownToLine,
  ArrowUpFromLine,
  DollarSign,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ScanLiveView from '@/components/scan/scan-live-view';

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

interface Props {
  params: { id: string };
}

export default async function ScanDetailPage({ params }: Props) {
  const supabase = createClient();
  const { data: scan } = await supabase.from('scans').select('*').eq('id', params.id).single();
  if (!scan) notFound();

  const { data: targets } = await supabase
    .from('scan_targets')
    .select('*')
    .eq('scan_id', params.id);

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/scans" className="transition-colors hover:text-neutral-300">
          Scans
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">{scan.run_name}</span>
      </nav>

      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-50">{scan.run_name}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-400">
          <span className="rounded-md bg-neutral-900 px-2 py-0.5 font-medium ring-1 ring-neutral-800">
            {scan.scan_mode}
          </span>
          {scan.scope_mode && (
            <span className="rounded-md bg-neutral-900 px-2 py-0.5 font-medium ring-1 ring-neutral-800">
              {scan.scope_mode}
            </span>
          )}
          {scan.llm_provider && (
            <span className="font-mono">{scan.llm_provider}</span>
          )}
          {scan.created_at && (
            <span>{new Date(scan.created_at).toLocaleString()}</span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={DollarSign}
          label="Cost"
          value={
            scan.total_cost != null && Number(scan.total_cost) > 0
              ? `$${Number(scan.total_cost).toFixed(4)}`
              : '$0.0000'
          }
          accent="amber"
        />
        <StatTile
          icon={ArrowDownToLine}
          label="Input tokens"
          value={formatTokens(scan.total_input_tokens)}
          accent="cyan"
        />
        <StatTile
          icon={ArrowUpFromLine}
          label="Output tokens"
          value={formatTokens(scan.total_output_tokens)}
          accent="violet"
        />
        <StatTile
          icon={Cpu}
          label="AI agents"
          value={scan.agents_count != null ? String(scan.agents_count) : '0'}
          hint="See what each one tested ↓"
          href="#agents"
          accent="emerald"
        />
      </section>

      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          <Target className="h-3.5 w-3.5" strokeWidth={2} />
          Targets
        </div>
        <ul className="mt-3 space-y-1.5">
          {targets?.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-sm">
              <span className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-400 ring-1 ring-neutral-800">
                {t.type}
              </span>
              <code className="font-mono text-neutral-200">{t.value}</code>
            </li>
          ))}
        </ul>
      </section>

      {scan.instruction_text && (
        <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/20 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Instructions
          </div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-300">{scan.instruction_text}</p>
        </section>
      )}

      <ScanLiveView
        scanId={params.id}
        initialStatus={scan.status}
        agentsCount={scan.agents_count ?? 0}
        initialHeartbeatAt={scan.last_heartbeat_at ?? null}
        initialCancelRequestedAt={scan.cancel_requested_at ?? null}
      />
    </div>
  );
}

const ACCENTS = {
  amber: 'text-amber-300/90 ring-amber-500/20',
  cyan: 'text-cyan-300/90 ring-cyan-500/20',
  violet: 'text-violet-300/90 ring-violet-500/20',
  emerald: 'text-emerald-300/90 ring-emerald-500/20',
} as const;

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
  hint,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  accent: keyof typeof ACCENTS;
  hint?: string;
  href?: string;
}) {
  const cls = ACCENTS[accent];
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
        <Icon className={`h-3 w-3 ${cls.split(' ')[0]}`} strokeWidth={2.25} />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-neutral-100">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10.5px] leading-snug text-neutral-500 transition-colors group-hover:text-cyan-300/80">
          {hint}
        </div>
      )}
    </>
  );
  const wrapperCls =
    'group block rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3 transition-colors';
  if (href) {
    return (
      <Link href={href} className={`${wrapperCls} hover:border-neutral-700`}>
        {body}
      </Link>
    );
  }
  return <div className={wrapperCls}>{body}</div>;
}
