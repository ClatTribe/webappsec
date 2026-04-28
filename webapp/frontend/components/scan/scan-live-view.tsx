'use client';

import { useEffect, useState } from 'react';
import { Activity, Pause, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Finding, ScanEvent, ScanStatus } from '@/lib/supabase/types';
import FindingCard from '@/components/finding/finding-card';
import FindingsSummary from '@/components/scan/findings-summary';
import BehindTheScenes from '@/components/scan/behind-the-scenes';
import AgentsSection from '@/components/scan/agents-section';

interface Props {
  scanId: string;
  initialStatus: ScanStatus;
  agentsCount?: number | null;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_PILL: Record<string, string> = {
  critical: 'bg-red-600/15 text-red-200 ring-1 ring-red-500/40',
  high: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-400/40',
  medium: 'bg-yellow-500/15 text-yellow-200 ring-1 ring-yellow-400/40',
  low: 'bg-lime-500/15 text-lime-200 ring-1 ring-lime-400/40',
  info: 'bg-neutral-700/40 text-neutral-200 ring-1 ring-neutral-600/40',
};

const STATUS_THEME: Record<
  ScanStatus,
  { label: string; Icon: LucideIcon; ring: string; tag: string; dot: string; tagline: (n: number) => string }
> = {
  queued: {
    label: 'Queued',
    Icon: Pause,
    ring: 'ring-neutral-700/60',
    tag: 'bg-neutral-700/40 text-neutral-300',
    dot: 'bg-neutral-500',
    tagline: () => 'Waiting for a worker to pick it up.',
  },
  running: {
    label: 'Running',
    Icon: Activity,
    ring: 'ring-blue-500/40',
    tag: 'bg-blue-500/20 text-blue-200',
    dot: 'bg-blue-500 status-dot-pulse',
    tagline: (n) => (n === 0 ? 'Agent is investigating — findings stream in as they appear.' : 'Agent is still investigating…'),
  },
  completed: {
    label: 'Completed',
    Icon: ShieldCheck,
    ring: 'ring-emerald-500/40',
    tag: 'bg-emerald-500/20 text-emerald-200',
    dot: 'bg-emerald-500',
    tagline: (n) => (n === 0 ? 'Scan finished cleanly with no findings.' : `${n} finding${n === 1 ? '' : 's'} produced.`),
  },
  failed: {
    label: 'Failed',
    Icon: ShieldX,
    ring: 'ring-red-500/40',
    tag: 'bg-red-500/20 text-red-200',
    dot: 'bg-red-500',
    tagline: () => 'Scan ended without finishing — check the timeline below.',
  },
  cancelled: {
    label: 'Cancelled',
    Icon: ShieldAlert,
    ring: 'ring-neutral-600/60',
    tag: 'bg-neutral-700/40 text-neutral-300',
    dot: 'bg-neutral-500',
    tagline: () => 'Scan was cancelled.',
  },
};

export default function ScanLiveView({ scanId, initialStatus, agentsCount }: Props) {
  const supabase = createClient();
  const [status, setStatus] = useState<ScanStatus>(initialStatus);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: ev }, { data: fd }] = await Promise.all([
        supabase
          .from('scan_events')
          .select('*')
          .eq('scan_id', scanId)
          .order('id', { ascending: true })
          .limit(500),
        supabase
          .from('findings')
          .select('*')
          .eq('scan_id', scanId)
          .order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;
      setEvents((ev ?? []) as ScanEvent[]);
      setFindings((fd ?? []) as Finding[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`scan:${scanId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scan_events', filter: `scan_id=eq.${scanId}` },
        (payload) => setEvents((prev) => [...prev, payload.new as ScanEvent]),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'findings', filter: `scan_id=eq.${scanId}` },
        (payload) => setFindings((prev) => [...prev, payload.new as Finding]),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'scans', filter: `id=eq.${scanId}` },
        (payload) => setStatus((payload.new as { status: ScanStatus }).status),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [scanId, supabase]);

  const sortedFindings = [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]);
    const sb = SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);
    return sa - sb;
  });

  const counts = SEVERITY_ORDER.map((s) => ({
    severity: s,
    count: findings.filter((f) => f.severity === s).length,
  }));

  const theme = STATUS_THEME[status];
  const StatusIcon = theme.Icon;

  return (
    <div className="space-y-6">
      {/* Hero status card */}
      <section
        className={`relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-gradient-to-b from-neutral-900/50 via-neutral-950/30 to-neutral-950/0 p-6 ring-1 ${theme.ring}`}
      >
        <div className="flex items-center gap-4">
          <div
            className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-neutral-900/70 ${theme.tag} ring-1 ring-inset ring-white/5`}
          >
            <StatusIcon className="h-6 w-6" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${theme.tag}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`} />
                {theme.label}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-neutral-300">{theme.tagline(findings.length)}</p>
          </div>
        </div>

        {/* Severity stat row */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {counts.map((c) => (
            <div
              key={c.severity}
              className={`rounded-lg px-3 py-2 ${
                c.count > 0 ? SEVERITY_PILL[c.severity] : 'bg-neutral-900/40 ring-1 ring-neutral-800/80'
              }`}
            >
              <div className={`text-xl font-semibold ${c.count > 0 ? '' : 'text-neutral-600'}`}>
                {c.count}
              </div>
              <div className="text-[10px] font-medium uppercase tracking-wider opacity-80">
                {c.severity}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* AI investigators — explains what an "agent" is and lists each one. */}
      <AgentsSection events={events} expectedCount={agentsCount ?? 0} />

      {/* What we found — categorised summary of the findings, in plain language. */}
      <FindingsSummary findings={findings} status={status} />

      {/* Findings — the canonical list, kept below the categorised summary so
          a reader who wants the raw view doesn't have to drill in. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            All findings
          </h2>
          {findings.length > 0 && (
            <span className="text-xs text-neutral-500">
              {findings.length} total · click any to expand
            </span>
          )}
        </div>
        {sortedFindings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-12 text-center">
            <div className="text-sm text-neutral-400">
              {status === 'queued' && 'Scan is queued. Findings will appear here as they arrive.'}
              {status === 'running' && 'Agent is investigating — findings appear here in real time.'}
              {status === 'completed' && 'No findings — scan completed cleanly.'}
              {status === 'failed' && 'Scan ended without producing findings.'}
              {status === 'cancelled' && 'Scan was cancelled.'}
            </div>
          </div>
        ) : (
          sortedFindings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
      </section>

      {/* Behind the scenes — agents, tools, attack surface. Collapsed by default;
          this is here for the curious / for debugging, not the primary read. */}
      <BehindTheScenes events={events} />
    </div>
  );
}
