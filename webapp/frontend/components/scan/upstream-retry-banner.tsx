'use client';

import { useEffect, useMemo, useState } from 'react';
import { CloudOff, Clock } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

// Engine PR #112 / wishlist §13.1 row 1 — live "upstream rate-limited" banner.
//
// Strix retries upstream LLM 5xx / 429 / connection errors with exponential
// backoff. While it's sleeping through a 45-second wait, the run looks stuck
// from the operator's vantage point. This banner surfaces the retry signal:
//
//   - Reads the most recent `llm.retry_attempted` event from the live event
//     stream and renders attempt N/M, status code, error type, and an ETA
//     countdown derived from `wait_seconds` minus elapsed-since-event.
//   - Auto-dismisses when a later `llm.request.completed` event arrives
//     (the retry succeeded) OR the ETA countdown elapses (banner stays
//     up another ~3s past zero so the eye catches the resolution).
//
// Pure derivation of the existing scan_events stream — no schema, no extra
// fetch. The banner sits at the very top of ScanLiveView's render tree
// (above the hero card) so a stuck retry is visible without scrolling.

interface RetryPayload {
  attempt?: number;
  max_retries?: number;
  wait_seconds?: number;
  status_code?: number;
  error_type?: string;
}

function shapeAsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function pickRetry(events: ScanEvent[]): { ev: ScanEvent; payload: RetryPayload } | null {
  // Walk newest-first; stop the moment we find either:
  //   (a) `llm.request.completed` — most recent action succeeded, no
  //       retry to surface
  //   (b) `llm.retry_attempted` — the in-flight backoff
  // Anything in between is irrelevant.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type === 'llm.request.completed') return null;
    if (ev.event_type === 'llm.retry_attempted') {
      const payload = shapeAsObject(ev.payload);
      const inner = shapeAsObject(payload.payload);
      const r: RetryPayload = {
        attempt: typeof inner.attempt === 'number' ? inner.attempt : (payload.attempt as number | undefined),
        max_retries: typeof inner.max_retries === 'number' ? inner.max_retries : (payload.max_retries as number | undefined),
        wait_seconds: typeof inner.wait_seconds === 'number' ? inner.wait_seconds : (payload.wait_seconds as number | undefined),
        status_code: typeof inner.status_code === 'number' ? inner.status_code : (payload.status_code as number | undefined),
        error_type: typeof inner.error_type === 'string' ? inner.error_type : (payload.error_type as string | undefined),
      };
      return { ev, payload: r };
    }
  }
  return null;
}

export default function UpstreamRetryBanner({ events }: { events: ScanEvent[] }) {
  const retry = useMemo(() => pickRetry(events), [events]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!retry) return;
    // Tick every second so the ETA countdown updates without the parent
    // having to re-render. Cleared automatically when `retry` flips
    // back to null on a subsequent llm.request.completed.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [retry]);

  if (!retry) return null;

  const { ev, payload } = retry;
  const startedAt = Date.parse(ev.created_at);
  const wait = (payload.wait_seconds ?? 0) * 1000;
  const elapsedMs = Math.max(0, now - startedAt);
  const remainMs = Math.max(0, wait - elapsedMs);
  // Keep the banner up for ~3s after the wait elapses so the operator's
  // eye catches the resolution. After that we let the next event stream
  // tick clear it (typically a `llm.request.completed`).
  if (wait > 0 && elapsedMs > wait + 3000) return null;

  const remainSec = Math.ceil(remainMs / 1000);

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3.5">
      <div className="flex items-start gap-3">
        <CloudOff
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300"
          strokeWidth={2.25}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[12.5px] font-medium text-amber-100">
              Upstream LLM rate-limited — retrying
            </span>
            {payload.attempt && payload.max_retries && (
              <span className="font-mono text-[11px] text-amber-200/80">
                attempt {payload.attempt} / {payload.max_retries}
              </span>
            )}
            {payload.status_code && (
              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200 ring-1 ring-amber-400/30">
                HTTP {payload.status_code}
              </span>
            )}
            {payload.error_type && (
              <span className="font-mono text-[10.5px] text-amber-300/70">
                {payload.error_type}
              </span>
            )}
          </div>
          <p className="text-[11.5px] leading-relaxed text-amber-200/80">
            {wait > 0 && remainMs > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3 w-3" strokeWidth={2.5} />
                Next retry in <span className="font-mono tabular-nums">{remainSec}s</span>
              </span>
            ) : wait > 0 ? (
              <>Retry should be firing now…</>
            ) : (
              <>Backoff in flight — strix will resume once upstream answers.</>
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
