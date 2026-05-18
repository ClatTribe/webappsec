import Link from 'next/link';
import { ShieldAlert, ScanLine, Sparkles, Zap, Clock, Eye, Ban } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import FindingsFilter from '@/components/finding/findings-filter';
import type { Finding } from '@/lib/supabase/types';

const RESOLVED = new Set(['fixed', 'false_positive', 'wont_fix']);

export default async function FindingsPage() {
  const supabase = createClient();
  // `findings` has two FK relationships to `scans` (`scan_id` and
  // `last_seen_scan_id`) since migration 010, so we disambiguate the
  // PostgREST embed by FK name. We also pull the cross-scan occurrence
  // ledger (migration 017) so the card can show the lifespan of each
  // finding without an extra round-trip.
  const { data } = await supabase
    .from('findings')
    .select(
      `*,
       scans!findings_scan_id_fkey(run_name, status),
       last_seen_scan:scans!findings_last_seen_scan_id_fkey(run_name),
       targets(name, value, type),
       finding_occurrences(scan_id, seen_at, reopened, scans(run_name))`
    )
    .order('created_at', { ascending: false })
    .limit(200);

  const findings = ((data as (Finding & {
    scans?: { run_name: string; status: string } | null;
    last_seen_scan?: { run_name: string } | null;
    targets?: { name: string; value: string; type: string } | null;
    finding_occurrences?: {
      scan_id: string;
      seen_at: string;
      reopened: boolean;
      scans?: { run_name: string } | null;
    }[] | null;
  })[]) ?? []);

  const open = findings.filter((f) => !RESOLVED.has(f.status));
  const fixNow = open.filter(
    (f) => f.ai_assessment?.urgency === 'fix_now',
  ).length;
  const fixSoon = open.filter(
    (f) => f.ai_assessment?.urgency === 'fix_soon',
  ).length;
  const monitor = open.filter(
    (f) => f.ai_assessment?.urgency === 'monitor',
  ).length;
  const dismissed = open.filter(
    (f) => f.ai_assessment?.urgency === 'dismiss',
  ).length;
  const unassessed = open.filter((f) => !f.ai_assessment).length;
  const totalAssessed = findings.filter((f) => f.ai_assessment).length;

  const urgentTotal = fixNow + fixSoon;

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Findings</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-neutral-400">
              Each finding is rated by an LLM for reachability, false-positive likelihood, and
              urgency. The default view shows only what the AI considers worth fixing now — toggle
              to <em>All</em> to see everything including dismissed false positives.
            </p>
          </div>
          {/* Tier II #11 — Recurring view CTA. We don't try to pre-
              compute the count here (would need another query for the
              same data the next page already fetches); just surface
              the entry point. */}
          <Link
            href="/findings/recurring"
            className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/20"
            title="The same finding hitting two or more of your assets — review them all as a group"
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2.25} />
            Recurring across targets
          </Link>
        </div>

        {findings.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <UrgencyTile
                label="Fix now"
                value={fixNow}
                Icon={Zap}
                tone="red"
                description="Real, reachable, high impact"
              />
              <UrgencyTile
                label="Fix soon"
                value={fixSoon}
                Icon={Clock}
                tone="orange"
                description="Real but lower impact"
              />
              <UrgencyTile
                label="Monitor"
                value={monitor}
                Icon={Eye}
                tone="amber"
                description="Needs human review"
              />
              <UrgencyTile
                label="Dismissed"
                value={dismissed}
                Icon={Ban}
                tone="neutral"
                description="AI flagged false positive"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-neutral-500">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-violet-400/80" strokeWidth={2.25} />
                {totalAssessed} of {findings.length} findings assessed by AI
                {unassessed > 0 && ` · ${unassessed} pending`}
              </div>
              <div>
                Of {findings.length} reported by the scanner, <strong className="text-neutral-300">{urgentTotal}</strong> are
                worth your time today.
              </div>
            </div>
          </>
        )}
      </header>

      {findings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/20 px-8 py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900 ring-1 ring-neutral-800">
            <ShieldAlert className="h-6 w-6 text-neutral-500" strokeWidth={1.75} />
          </div>
          <h3 className="mt-4 text-base font-medium text-neutral-200">No findings yet</h3>
          <p className="mt-1 text-sm text-neutral-500">Findings appear here as scans complete.</p>
          <Link
            href="/scans/new"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-200"
          >
            <ScanLine className="h-4 w-4" />
            Start a scan
          </Link>
        </div>
      ) : (
        <FindingsFilter findings={findings} />
      )}
    </div>
  );
}

const TONE: Record<string, { tile: string; pill: string; iconBg: string }> = {
  red: {
    tile: 'border-red-500/30 bg-gradient-to-b from-red-500/10 to-red-500/0',
    pill: 'text-red-200',
    iconBg: 'bg-red-500/20 text-red-200',
  },
  orange: {
    tile: 'border-orange-500/30 bg-gradient-to-b from-orange-500/10 to-orange-500/0',
    pill: 'text-orange-200',
    iconBg: 'bg-orange-500/20 text-orange-200',
  },
  amber: {
    tile: 'border-amber-500/30 bg-gradient-to-b from-amber-500/10 to-amber-500/0',
    pill: 'text-amber-200',
    iconBg: 'bg-amber-500/20 text-amber-200',
  },
  neutral: {
    tile: 'border-neutral-800 bg-neutral-900/30',
    pill: 'text-neutral-300',
    iconBg: 'bg-neutral-800 text-neutral-400',
  },
};

function UrgencyTile({
  label,
  value,
  Icon,
  tone,
  description,
}: {
  label: string;
  value: number;
  Icon: typeof Zap;
  tone: keyof typeof TONE;
  description: string;
}) {
  const t = TONE[tone];
  return (
    <div className={`rounded-xl border ${t.tile} px-4 py-3.5`}>
      <div className="flex items-start justify-between">
        <div>
          <div className={`text-3xl font-semibold tracking-tight ${value > 0 ? t.pill : 'text-neutral-600'}`}>
            {value}
          </div>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            {label}
          </div>
          <div className="text-[10.5px] text-neutral-500">{description}</div>
        </div>
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ring-white/5 ${t.iconBg}`}>
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
      </div>
    </div>
  );
}
