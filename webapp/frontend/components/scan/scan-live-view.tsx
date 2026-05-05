'use client';

import { useEffect, useState } from 'react';
import { Activity, Pause, ShieldAlert, ShieldCheck, ShieldX, AlertTriangle, X, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Finding, ScanEvent, ScanStatus } from '@/lib/supabase/types';
import FindingCard from '@/components/finding/finding-card';
import BehindTheScenes from '@/components/scan/behind-the-scenes';
import AgentsSection from '@/components/scan/agents-section';
import PhaseProgress from '@/components/scan/phase-progress';
import HypothesisPane from '@/components/scan/hypothesis-pane';
import ComplianceOverlay from '@/components/scan/compliance-overlay';
import UpstreamRetryBanner from '@/components/scan/upstream-retry-banner';

interface Props {
  scanId: string;
  initialStatus: ScanStatus;
  agentsCount?: number | null;
  initialHeartbeatAt?: string | null;
  initialCancelRequestedAt?: string | null;
  initialErrorMessage?: string | null;
  initialExitCode?: number | null;
}

// A scan is "stale" if it's still in 'running' but hasn't heartbeat'd in this
// many seconds. The worker ticks every 60s and the sweep tolerance is 10
// minutes, so showing the badge at 5 minutes gives the user an early warning
// while still being well past one missed beat.
const STALE_HEARTBEAT_THRESHOLD_SEC = 5 * 60;

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

export default function ScanLiveView({
  scanId,
  initialStatus,
  agentsCount,
  initialHeartbeatAt,
  initialCancelRequestedAt,
  initialErrorMessage,
  initialExitCode,
}: Props) {
  const supabase = createClient();
  const [status, setStatus] = useState<ScanStatus>(initialStatus);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [heartbeatAt, setHeartbeatAt] = useState<string | null>(initialHeartbeatAt ?? null);
  const [cancelRequestedAt, setCancelRequestedAt] = useState<string | null>(
    initialCancelRequestedAt ?? null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(initialErrorMessage ?? null);
  const [exitCode, setExitCode] = useState<number | null>(initialExitCode ?? null);
  const [cancelInFlight, setCancelInFlight] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // A wall-clock tick so the staleness check re-evaluates every minute even
  // when no DB updates arrive (which is exactly the failure mode the badge
  // is meant to catch).
  const [, setNowTick] = useState(0);

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
        (payload) => {
          const row = payload.new as {
            status: ScanStatus;
            last_heartbeat_at?: string | null;
            cancel_requested_at?: string | null;
            error_message?: string | null;
            exit_code?: number | null;
          };
          setStatus(row.status);
          if (row.last_heartbeat_at !== undefined) setHeartbeatAt(row.last_heartbeat_at);
          if (row.cancel_requested_at !== undefined) setCancelRequestedAt(row.cancel_requested_at);
          if (row.error_message !== undefined) setErrorMessage(row.error_message);
          if (row.exit_code !== undefined) setExitCode(row.exit_code);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [scanId, supabase]);

  // Re-render once a minute so the stale-heartbeat badge catches a worker
  // that goes silent without anything else changing on the row.
  useEffect(() => {
    if (status !== 'running') return;
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [status]);

  const handleCancel = async () => {
    if (cancelInFlight) return;
    setCancelInFlight(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/scans/${scanId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCancelError(body?.error ?? `failed (${res.status})`);
        return;
      }
      // Optimistic — the realtime UPDATE will overwrite this when the worker
      // actually flips the row.
      setCancelRequestedAt(new Date().toISOString());
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setCancelInFlight(false);
    }
  };

  const heartbeatStale =
    status === 'running' &&
    heartbeatAt != null &&
    Date.now() - Date.parse(heartbeatAt) > STALE_HEARTBEAT_THRESHOLD_SEC * 1000;
  const showCancelButton = status === 'queued' || status === 'running';
  const cancelPending = cancelRequestedAt != null && status === 'running';

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
      {/* Live "upstream rate-limited" banner (engine PR #112). Sits at the
          top of the live-view tree so a stuck retry is visible without
          scrolling — operators were wondering "is it stuck?" while strix
          slept through 45-second backoffs. Renders nothing when no retry
          is in flight. */}
      <UpstreamRetryBanner events={events} />

      {/* Hero status card */}
      <section
        className={`relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-gradient-to-b from-neutral-900/50 via-neutral-950/30 to-neutral-950/0 p-6 ring-1 ${theme.ring}`}
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-neutral-900/70 ${theme.tag} ring-1 ring-inset ring-white/5`}
          >
            <StatusIcon className="h-6 w-6" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${theme.tag}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`} />
                {theme.label}
              </span>
              {cancelPending && (
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30">
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                  Cancel pending
                </span>
              )}
              {heartbeatStale && (
                <span className="inline-flex items-center gap-1 rounded-md bg-yellow-500/15 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-yellow-200 ring-1 ring-yellow-400/30">
                  <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />
                  Stalled
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm text-neutral-300">
              {cancelPending
                ? 'Cancellation requested — the worker is shutting the scan down.'
                : heartbeatStale
                  ? "Worker hasn't checked in for several minutes. The scan may have stalled — it'll be auto-failed if it stays silent."
                  : theme.tagline(findings.length)}
            </p>
          </div>
          {showCancelButton && (
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelInFlight || cancelPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:border-red-500/50 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  cancelPending
                    ? 'Cancellation already requested'
                    : 'Stop this scan immediately'
                }
              >
                {cancelInFlight ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
                ) : (
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                )}
                {cancelPending ? 'Cancelling…' : 'Cancel scan'}
              </button>
              {cancelError && (
                <span className="text-[10.5px] text-red-300">{cancelError}</span>
              )}
            </div>
          )}
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

      {/* Failure cause — only when the scan ended badly. We surface
          (1) the structured `error_message` we wrote on finish, and
          (2) the last few stderr/stdout lines that contain "Error:" /
          "Exception" — the actual upstream error usually lives there
          (e.g. a Gemini 503 ServiceUnavailable). Without this the user
          had to scroll a 200-line raw log to find the real cause. */}
      {(status === 'failed' || status === 'cancelled') && (
        <FailureCause
          status={status}
          errorMessage={errorMessage}
          exitCode={exitCode}
          events={events}
        />
      )}

      {/* Per-phase coverage receipt (engine PR #140 / wishlist §15.4).
          Renders the four canonical phases (recon → exploit → validate
          → report) with the engine's self-audit `categories_covered`
          per phase; gate-breach banner when `categories_skipped` non-
          empty. Hidden until the engine emits a `phase.entered` event
          (older versions / pre-recon phase). */}
      <PhaseProgress events={events} />

      {/* Active-hypothesis live pane (engine PR #138 / wishlist §15.4).
          Cross-specialist hypotheses with status (open / confirmed /
          dismissed). Operator sees what the engine is investigating
          right now — the live-scan equivalent of looking over a senior
          pen-tester's shoulder. Confirmed rows deep-link to the
          finding card via #finding-<id>. */}
      <HypothesisPane events={events} />

      {/* AI investigators — explains what an "agent" is and lists each one. */}
      <AgentsSection events={events} expectedCount={agentsCount ?? 0} />

      {/* Findings — the only findings list on the page. The earlier
          categorised "What we found" summary duplicated this view (each
          category card just expanded into the same finding cards) so it
          was removed in favour of the flat severity-sorted list. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Findings
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

      {/* Compliance overlay — findings grouped by control framework
          (engine PR #103 / wishlist §14.4). Collapsed by default;
          appears beneath the flat findings list so the primary read
          stays severity-sorted. Hidden when none of the findings
          carry a `compliance_controls` mapping. */}
      <ComplianceOverlay findings={findings} />

      {/* Behind the scenes — agents, tools, attack surface. Collapsed by default;
          this is here for the curious / for debugging, not the primary read. */}
      <BehindTheScenes events={events} />
    </div>
  );
}

// Pulls the last meaningful error out of the streamed log events. Strix
// (and most CLIs) prints the diagnostic line just before exiting; that's
// where the real cause lives. We scan the last 30 log lines and surface
// the most recent one that looks like an error.
function extractLastErrorLine(events: ScanEvent[]): string | null {
  const ERROR_PATTERN = /\b(error|exception|fatal|failed|unavailable|timeout|denied)\b/i;
  const tail = events.slice(-30).reverse();
  for (const ev of tail) {
    if (ev.event_type !== 'log') continue;
    const line = (ev.payload as { line?: string } | null)?.line ?? '';
    // Strip Rich box-drawing chars + leading │/╰/─ so the cause is readable.
    const cleaned = line.replace(/[│╭╮╰╯─]/g, '').trim();
    if (cleaned && ERROR_PATTERN.test(cleaned)) {
      return cleaned.length > 280 ? `${cleaned.slice(0, 280)}…` : cleaned;
    }
  }
  return null;
}

function FailureCause({
  status,
  errorMessage,
  exitCode,
  events,
}: {
  status: ScanStatus;
  errorMessage: string | null;
  exitCode: number | null;
  events: ScanEvent[];
}) {
  const lastErr = extractLastErrorLine(events);
  const isCancelled = status === 'cancelled';
  const headline = isCancelled ? 'Scan cancelled' : 'Scan failed';
  const accent = isCancelled
    ? 'border-neutral-700 bg-neutral-900/40'
    : 'border-red-500/30 bg-red-500/5';

  return (
    <section className={`rounded-2xl border p-5 ${accent}`}>
      <div className="flex items-start gap-3">
        <ShieldX
          className={`mt-0.5 h-5 w-5 flex-shrink-0 ${
            isCancelled ? 'text-neutral-400' : 'text-red-300'
          }`}
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2
              className={`text-sm font-semibold ${
                isCancelled ? 'text-neutral-200' : 'text-red-100'
              }`}
            >
              {headline}
            </h2>
            <p className="mt-1 text-xs text-neutral-400">
              {errorMessage ?? 'No structured error message was recorded.'}
              {exitCode != null && exitCode !== 0 && (
                <span className="ml-2 font-mono text-neutral-500">
                  (exit code {exitCode})
                </span>
              )}
            </p>
          </div>

          {lastErr && !isCancelled && (
            <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-3">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
                Last error from the run
              </div>
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-red-200/90">
                {lastErr}
              </pre>
              <p className="mt-2 text-[11px] text-neutral-500">
                Most upstream LLM rate-limits / 5xx errors look like this and
                are transient — re-run the scan from the target page.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
