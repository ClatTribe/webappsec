'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ScanLine, EyeOff, Eye, Sparkles } from 'lucide-react';
import FindingCard from './finding-card';
import type { AiUrgency, Finding } from '@/lib/supabase/types';

type FindingWithScan = Finding & { scans?: { run_name: string; status: string } | null };

const RESOLVED_STATUSES = new Set(['fixed', 'false_positive', 'wont_fix']);

const URGENCY_RANK: Record<AiUrgency, number> = {
  fix_now: 0,
  fix_soon: 1,
  monitor: 2,
  dismiss: 3,
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

type ViewMode = 'urgent' | 'all_open' | 'all';

const VIEW_MODES: { value: ViewMode; label: string; help: string }[] = [
  {
    value: 'urgent',
    label: 'Urgent',
    help: 'AI says fix-now or fix-soon, hides dismissed/resolved.',
  },
  { value: 'all_open', label: 'Open', help: 'Anything not yet fixed/dismissed.' },
  { value: 'all', label: 'All', help: 'Including dismissed and resolved.' },
];

export default function FindingsFilter({ findings }: { findings: FindingWithScan[] }) {
  const [view, setView] = useState<ViewMode>('urgent');

  const sorted = useMemo(() => {
    const arr = [...findings];
    arr.sort((a, b) => {
      const ua = URGENCY_RANK[a.ai_assessment?.urgency ?? 'monitor'];
      const ub = URGENCY_RANK[b.ai_assessment?.urgency ?? 'monitor'];
      if (ua !== ub) return ua - ub;
      const sa = SEVERITY_RANK[a.severity] ?? 99;
      const sb = SEVERITY_RANK[b.severity] ?? 99;
      return sa - sb;
    });
    return arr;
  }, [findings]);

  const visible = useMemo(() => {
    return sorted.filter((f) => {
      const isResolved = RESOLVED_STATUSES.has(f.status);
      const aiSaysDismiss = f.ai_assessment?.urgency === 'dismiss';
      if (view === 'all') return true;
      if (view === 'all_open') return !isResolved;
      // 'urgent': AI says fix_now or fix_soon AND not resolved AND not dismissed.
      const u = f.ai_assessment?.urgency;
      if (u && (u === 'fix_now' || u === 'fix_soon')) return !isResolved;
      // No AI assessment yet → fall back to severity, surface critical/high.
      if (!f.ai_assessment && (f.severity === 'critical' || f.severity === 'high'))
        return !isResolved;
      if (aiSaysDismiss) return false;
      return false;
    });
  }, [sorted, view]);

  const counts = useMemo(() => {
    let urgent = 0;
    let monitor = 0;
    let dismiss = 0;
    let unassessed = 0;
    let resolved = 0;
    for (const f of findings) {
      if (RESOLVED_STATUSES.has(f.status)) {
        resolved++;
        continue;
      }
      const u = f.ai_assessment?.urgency;
      if (u === 'fix_now' || u === 'fix_soon') urgent++;
      else if (u === 'monitor') monitor++;
      else if (u === 'dismiss') dismiss++;
      else unassessed++;
    }
    return { urgent, monitor, dismiss, unassessed, resolved };
  }, [findings]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3">
        <div className="inline-flex rounded-lg bg-neutral-950/60 p-1 ring-1 ring-neutral-800">
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setView(m.value)}
              title={m.help}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                view === m.value
                  ? 'bg-neutral-800 text-neutral-50 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-100'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-red-300 ring-1 ring-red-500/30">
            {counts.urgent} urgent
          </span>
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-300 ring-1 ring-amber-500/30">
            {counts.monitor} monitor
          </span>
          <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-neutral-400">
            {counts.dismiss} dismissed by AI
          </span>
          {counts.unassessed > 0 && (
            <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-neutral-400">
              {counts.unassessed} not-yet-assessed
            </span>
          )}
          {counts.resolved > 0 && (
            <span className="rounded-md bg-neutral-800 px-2 py-0.5 text-neutral-400">
              {counts.resolved} resolved
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-1 text-[11px] text-neutral-500">
        <Sparkles className="h-3 w-3 text-violet-400/70" strokeWidth={2.25} />
        AI triage filters out likely false positives and ranks the rest by reachability +
        impact. Toggle to <em>All</em> to see everything.
      </div>

      <div className="space-y-3">
        {visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-10 text-center text-sm text-neutral-400">
            {view === 'urgent'
              ? 'No urgent findings — nothing the AI thinks needs immediate action.'
              : 'No findings match the current filter.'}
          </div>
        ) : (
          visible.map((f) => (
            <div key={f.id}>
              {f.scans?.run_name && (
                <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-neutral-500">
                  <ScanLine className="h-3 w-3" strokeWidth={2} />
                  Found in scan{' '}
                  <Link
                    href={`/scans/${f.scan_id}`}
                    className="font-medium text-neutral-300 transition-colors hover:text-cyan-300"
                  >
                    {f.scans.run_name}
                  </Link>
                </div>
              )}
              <FindingCard finding={f} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
