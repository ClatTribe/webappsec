'use client';

import { useMemo } from 'react';
import {
  Brain,
  Activity,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Lightbulb,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

// HypothesisPane — engine PR #138 / wishlist §15.4 / usage.md §3.5.
//
// Engine sub-agents post working hypotheses to a shared
// `active_hypotheses.jsonl` log; lifecycle events fire on every
// transition: `hypothesis.opened` → `hypothesis.confirmed` (with a
// linked_finding_id) | `hypothesis.dismissed` (with a 13-value reason).
// This pane gives the operator the "what's the engine actively
// investigating right now?" view — the live-scan equivalent of looking
// over a senior pen-tester's shoulder.
//
// Layout intent (from usage.md §5.2.2):
//   • Open hypotheses ranked by recency — surface, category,
//     hypothesis text, originating agent, "X ago" timestamp
//   • Confirmed hypotheses fold into a small summary tile (with a
//     deep-link to the finding card via #finding-<id>)
//   • Dismissed hypotheses fold into another tile with the reason
//
// Per Architecture.md §1.1 — we consume the engine's structured signal
// (event types + closed-enum reason) verbatim. No re-derivation.

type HypothesisStatus = 'open' | 'confirmed' | 'dismissed';

interface HypothesisRow {
  id: string;
  status: HypothesisStatus;
  surface: string;
  category: string;
  hypothesis: string;
  agent_id: string;
  agent_name: string | null;
  agent_category: string | null;
  opened_at: string;
  resolved_at: string | null;
  /** Set on confirmed status — id of the linked finding row (so the
   *  operator can click through to the casefile). */
  linked_finding_id: string | null;
  /** Set on dismissed status — engine-supplied closed-enum reason. */
  dismissal_reason: string | null;
}

function shapeAsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function pickStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function pickStrOrNull(...vals: unknown[]): string | null {
  const s = pickStr(...vals);
  return s ? s : null;
}

// Hypothesis-id derivation: engine emits a stable `hypothesis_id` on
// `confirmed`/`dismissed`; on `opened` we don't always have one (older
// engines), so fall back to a synthetic key from (surface, category,
// agent_id) which the engine's own dedup uses.
function hypothesisKey(payload: Record<string, unknown>, inner: Record<string, unknown>): string {
  const direct = pickStr(inner.hypothesis_id, payload.hypothesis_id);
  if (direct) return direct;
  const surface = pickStr(inner.surface, payload.surface);
  const category = pickStr(inner.category, payload.category);
  const actor = shapeAsObject(payload.actor);
  const agentId = pickStr(actor.agent_id, inner.agent_id, payload.agent_id);
  return `${surface}|${category}|${agentId}` || `h-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveHypotheses(events: ScanEvent[]): HypothesisRow[] {
  const byId = new Map<string, HypothesisRow>();

  for (const ev of events) {
    if (
      ev.event_type !== 'hypothesis.opened'
      && ev.event_type !== 'hypothesis.confirmed'
      && ev.event_type !== 'hypothesis.dismissed'
    ) {
      continue;
    }

    const payload = shapeAsObject(ev.payload);
    const inner = shapeAsObject(payload.payload);
    const actor = shapeAsObject(payload.actor);
    const id = hypothesisKey(payload, inner);

    let row = byId.get(id);
    if (!row) {
      row = {
        id,
        status: 'open',
        surface: pickStr(inner.surface, payload.surface),
        category: pickStr(inner.category, payload.category),
        hypothesis: pickStr(inner.hypothesis, payload.hypothesis),
        agent_id: pickStr(actor.agent_id, inner.agent_id, payload.agent_id),
        agent_name: pickStrOrNull(actor.agent_name, inner.agent_name),
        agent_category: pickStrOrNull(actor.agent_category, inner.agent_category, payload.category),
        opened_at: ev.created_at,
        resolved_at: null,
        linked_finding_id: null,
        dismissal_reason: null,
      };
      byId.set(id, row);
    } else {
      // Opportunistically backfill any field the original event didn't
      // carry — engines sometimes emit a thin `dismissed`/`confirmed`
      // before we ever saw an `opened` (out-of-order subscription).
      if (!row.surface) row.surface = pickStr(inner.surface, payload.surface);
      if (!row.category) row.category = pickStr(inner.category, payload.category);
      if (!row.hypothesis) row.hypothesis = pickStr(inner.hypothesis, payload.hypothesis);
      if (!row.agent_id) {
        row.agent_id = pickStr(actor.agent_id, inner.agent_id, payload.agent_id);
      }
    }

    if (ev.event_type === 'hypothesis.opened') {
      // Earliest-wins for opened_at.
      if (Date.parse(ev.created_at) < Date.parse(row.opened_at)) {
        row.opened_at = ev.created_at;
      }
    } else if (ev.event_type === 'hypothesis.confirmed') {
      row.status = 'confirmed';
      row.resolved_at = ev.created_at;
      row.linked_finding_id = pickStrOrNull(
        inner.linked_finding_id,
        payload.linked_finding_id,
        inner.finding_id,
      );
    } else if (ev.event_type === 'hypothesis.dismissed') {
      // Don't downgrade a confirmed back to dismissed if events arrive
      // out-of-order — confirmed is terminal in the engine's state
      // machine.
      if (row.status !== 'confirmed') {
        row.status = 'dismissed';
        row.resolved_at = ev.created_at;
        row.dismissal_reason = pickStrOrNull(inner.dismissal_reason, payload.dismissal_reason);
      }
    }
  }

  return [...byId.values()];
}

const STATUS_ICON: Record<HypothesisStatus, { Icon: LucideIcon; cls: string; label: string }> = {
  open: { Icon: Activity, cls: 'text-blue-300', label: 'investigating' },
  confirmed: { Icon: CheckCircle2, cls: 'text-emerald-300', label: 'confirmed' },
  dismissed: { Icon: XCircle, cls: 'text-neutral-500', label: 'dismissed' },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function HypothesisPane({ events }: { events: ScanEvent[] }) {
  const hypotheses = useMemo(() => deriveHypotheses(events), [events]);

  if (hypotheses.length === 0) return null;

  // Sort: open first (newest first), then confirmed, then dismissed.
  // Inside each bucket, most-recent activity wins.
  const open = hypotheses
    .filter((h) => h.status === 'open')
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
  const confirmed = hypotheses
    .filter((h) => h.status === 'confirmed')
    .sort((a, b) => Date.parse(b.resolved_at ?? b.opened_at) - Date.parse(a.resolved_at ?? a.opened_at));
  const dismissed = hypotheses
    .filter((h) => h.status === 'dismissed')
    .sort((a, b) => Date.parse(b.resolved_at ?? b.opened_at) - Date.parse(a.resolved_at ?? a.opened_at));

  const distinctAgents = new Set(open.map((h) => h.agent_id).filter(Boolean));

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5 text-cyan-300" strokeWidth={2.25} />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Open hypotheses
          </h2>
        </div>
        <div className="text-[10.5px] text-neutral-500" title="Engine sub-agents post working theories to a shared log; this pane shows what's actively under investigation right now.">
          {open.length} open
          {distinctAgents.size > 0 && ` · ${distinctAgents.size} specialist${distinctAgents.size === 1 ? '' : 's'} active`}
          {confirmed.length > 0 && ` · ${confirmed.length} confirmed`}
          {dismissed.length > 0 && ` · ${dismissed.length} dismissed`}
        </div>
      </div>

      {open.length > 0 ? (
        <ul className="space-y-1.5">
          {open.map((h) => (
            <HypothesisRow key={h.id} hypothesis={h} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-800 bg-neutral-950/30 px-3 py-4 text-center text-[11.5px] text-neutral-500">
          No open hypotheses right now — the engine has either resolved everything it was investigating, or hasn't opened any yet.
        </p>
      )}

      {(confirmed.length > 0 || dismissed.length > 0) && (
        <div className="space-y-2 border-t border-neutral-800/60 pt-3">
          {confirmed.length > 0 && (
            <ResolvedGroup
              title="Confirmed"
              Icon={Lightbulb}
              accent="text-emerald-300"
              hypotheses={confirmed}
            />
          )}
          {dismissed.length > 0 && (
            <ResolvedGroup
              title="Ruled out"
              Icon={XCircle}
              accent="text-neutral-500"
              hypotheses={dismissed}
            />
          )}
        </div>
      )}
    </section>
  );
}

function HypothesisRow({ hypothesis: h }: { hypothesis: HypothesisRow }) {
  const meta = STATUS_ICON[h.status];
  const Icon = meta.Icon;
  const agentLabel = h.agent_name ?? h.agent_id ?? 'agent';

  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-neutral-800/60 bg-neutral-950/30 px-3 py-2">
      <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${meta.cls}`} strokeWidth={2.25} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
          <span className="font-mono font-medium text-cyan-200/90">{agentLabel}</span>
          {h.surface && (
            <span className="font-mono text-neutral-500">→ {h.surface}</span>
          )}
          {h.category && (
            <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300 ring-1 ring-neutral-700/50">
              {h.category}
            </span>
          )}
        </div>
        {h.hypothesis && (
          <p className="text-[12px] leading-relaxed text-neutral-300">{h.hypothesis}</p>
        )}
      </div>
      <span
        className="ml-auto flex-shrink-0 self-start text-[10.5px] tabular-nums text-neutral-500"
        title={new Date(h.opened_at).toLocaleString()}
      >
        {relativeTime(h.opened_at)}
      </span>
    </li>
  );
}

function ResolvedGroup({
  title,
  Icon,
  accent,
  hypotheses,
}: {
  title: string;
  Icon: LucideIcon;
  accent: string;
  hypotheses: HypothesisRow[];
}) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400 hover:text-neutral-200">
        <Icon className={`h-3 w-3 ${accent}`} strokeWidth={2.5} />
        <span>
          {title} · {hypotheses.length}
        </span>
        <span className="ml-1 text-[10px] text-neutral-600 group-open:hidden">
          (click to expand)
        </span>
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {hypotheses.slice(0, 25).map((h) => (
          <li
            key={h.id}
            className="flex items-start gap-2 rounded-md border border-neutral-800/40 bg-neutral-950/20 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1 space-y-0.5 text-[11.5px]">
              <div className="flex flex-wrap items-baseline gap-x-2 text-neutral-400">
                <span className="font-mono">{h.agent_name ?? h.agent_id}</span>
                {h.surface && <span className="font-mono text-neutral-500">→ {h.surface}</span>}
                {h.category && (
                  <span className="text-[10px] text-neutral-500">[{h.category}]</span>
                )}
              </div>
              {h.hypothesis && (
                <p className="text-neutral-400">{h.hypothesis}</p>
              )}
              {h.status === 'dismissed' && h.dismissal_reason && (
                <div className="text-[10.5px] text-neutral-500">
                  <span className="text-neutral-600">reason:</span> {h.dismissal_reason}
                </div>
              )}
              {h.status === 'confirmed' && h.linked_finding_id && (
                <a
                  href={`#finding-${h.linked_finding_id}`}
                  className="inline-flex items-center gap-1 text-[10.5px] text-emerald-300/90 hover:text-emerald-200 hover:underline"
                >
                  see finding
                  <ArrowRight className="h-2.5 w-2.5" strokeWidth={2.5} />
                </a>
              )}
            </div>
          </li>
        ))}
        {hypotheses.length > 25 && (
          <li className="px-2 text-[10.5px] text-neutral-600">
            + {hypotheses.length - 25} more
          </li>
        )}
      </ul>
    </details>
  );
}
