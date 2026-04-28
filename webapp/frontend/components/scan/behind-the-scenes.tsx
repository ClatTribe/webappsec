'use client';

import { useMemo, useState } from 'react';
import { Sparkles, ChevronRight } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';
import SecurityReview from '@/components/scan/security-review';

// Wraps the technical breakdown (agents / tools / surface) in a collapsed
// expander. Most readers don't care which AI agent ran which tool; that
// detail belongs out of the way until someone asks for it.
export default function BehindTheScenes({ events }: { events: ScanEvent[] }) {
  const [open, setOpen] = useState(false);

  // Quick top-line tally so the header is informative even when collapsed.
  const tally = useMemo(() => {
    let toolCalls = 0;
    const surfaces = new Set<string>();
    for (const ev of events) {
      if (ev.event_type !== 'tool.execution.started') continue;
      toolCalls += 1;
      const payload = (ev.payload ?? {}) as Record<string, unknown>;
      const inner = (payload.payload ?? {}) as Record<string, unknown>;
      const args = (inner.args ?? {}) as Record<string, unknown>;
      for (const k of ['url', 'endpoint', 'target', 'path']) {
        const v = args[k];
        if (typeof v === 'string' && v.trim()) surfaces.add(v);
      }
    }
    return { toolCalls, surfaceCount: surfaces.size };
  }, [events]);

  const empty = tally.toolCalls === 0;

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
      <button
        type="button"
        onClick={() => !empty && setOpen((v) => !v)}
        className={`flex w-full items-center justify-between px-5 py-3 text-left transition-colors ${
          empty ? 'cursor-default' : 'hover:bg-neutral-900/50'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <ChevronRight
            className={`h-3.5 w-3.5 text-neutral-600 transition-transform ${
              empty ? 'invisible' : ''
            } ${open ? 'rotate-90 text-neutral-300' : ''}`}
            strokeWidth={2.5}
          />
          <Sparkles className="h-3.5 w-3.5 text-neutral-500" strokeWidth={2} />
          <span className="text-[13px] font-medium text-neutral-300">Behind the scenes</span>
          <span className="text-[11px] text-neutral-500">
            {empty
              ? 'no agent activity recorded yet'
              : `${tally.toolCalls} tool call${tally.toolCalls === 1 ? '' : 's'} · ${tally.surfaceCount} surface${tally.surfaceCount === 1 ? '' : 's'} probed`}
          </span>
        </div>
      </button>
      {open && !empty && (
        <div className="border-t border-neutral-800/60 bg-neutral-950/30 p-5">
          <SecurityReview events={events} />
        </div>
      )}
    </section>
  );
}
