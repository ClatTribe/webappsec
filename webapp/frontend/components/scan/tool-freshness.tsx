'use client';

import { useMemo } from 'react';
import { Wrench, Clock, Activity } from 'lucide-react';
import type { ScanEvent, RunMeta } from '@/lib/supabase/types';

// Tier I #3 — Tool freshness panel on scan-detail.
//
// Surfaces a per-tool roll-up of every external tool the engine fired
// during this scan: tool name, # of invocations, last invocation
// timestamp, and (when the engine emits it under `run_meta.tools`) the
// tool's content-freshness metadata — e.g. Nuclei templates count + DB
// age, Trivy DB age, ZAP rule count, gitleaks ruleset version.
//
// Two data sources, layered (per CLAUDE.md §1: prefer engine-emitted
// structured data, fall back to event-derived as the floor):
//
//   1. `scans.run_meta.tools[name]` — engine-emitted (forward-compat
//      shape — we read whatever keys the engine writes, render the
//      ones we recognise: `version`, `templates_count`, `db_age_hours`,
//      `last_updated`). When present this is the authoritative source.
//
//   2. `scan_events` of type `tool.execution.started` — every recorded
//      tool call. Always available; gives the count + last-call ts even
//      for older engines that don't emit run_meta.tools.
//
// The panel is hidden when no tool was invoked AND no tool meta was
// emitted — older scans don't get an empty box.

interface Props {
  events: ScanEvent[];
  runMeta?: RunMeta | null;
}

// What the engine *might* publish under run_meta.tools[name]. All
// optional — we render whatever the engine wrote and forward-ignore
// the rest.
interface ToolMeta {
  version?: string | number;
  templates_count?: number;
  rules_count?: number;
  db_age_hours?: number;
  last_updated?: string;
  templates_updated_at?: string;
  db_updated_at?: string;
  [k: string]: unknown;
}

interface ToolRow {
  name: string;
  invocations: number;
  lastCallAt: string | null;
  meta: ToolMeta | null;
}

export default function ToolFreshness({ events, runMeta }: Props) {
  const rows = useMemo(() => derive(events, runMeta), [events, runMeta]);

  if (rows.length === 0) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          Tool freshness
        </h2>
        <span
          className="text-[10.5px] text-neutral-500"
          title="What external tools the engine ran during this scan, how many times, and (when the tool publishes it) how fresh its rule/template DB is."
        >
          {rows.length} tool{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.name}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-neutral-800/60 bg-neutral-950/40 px-3 py-2"
          >
            <Wrench className="h-3.5 w-3.5 text-amber-300/80" strokeWidth={2.25} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px] text-neutral-200">{r.name}</span>
                {r.meta?.version !== undefined && (
                  <span className="font-mono text-[10.5px] text-neutral-500">
                    v{String(r.meta.version)}
                  </span>
                )}
                {typeof r.meta?.templates_count === 'number' && (
                  <span className="text-[10.5px] text-emerald-300/80">
                    {r.meta.templates_count.toLocaleString()} templates
                  </span>
                )}
                {typeof r.meta?.rules_count === 'number' && (
                  <span className="text-[10.5px] text-emerald-300/80">
                    {r.meta.rules_count.toLocaleString()} rules
                  </span>
                )}
                <FreshnessChip meta={r.meta} />
              </div>
            </div>
            <div className="flex items-center gap-3 text-[10.5px] text-neutral-500">
              {r.lastCallAt && (
                <span className="inline-flex items-center gap-1" title={r.lastCallAt}>
                  <Clock className="h-2.5 w-2.5" strokeWidth={2.25} />
                  last call {relativeTime(r.lastCallAt)}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Activity className="h-2.5 w-2.5" strokeWidth={2.25} />
                <span className="font-mono text-neutral-300">{r.invocations}</span>×
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FreshnessChip({ meta }: { meta: ToolMeta | null }) {
  if (!meta) return null;
  const ageHours = resolveAgeHours(meta);
  if (ageHours === null) return null;

  // Tier banding mirrors Snyk / Aikido's "DB age" UX:
  //   < 24h  → emerald  ("current")
  //   < 168h → cyan     ("fresh"  ≤ 1 week)
  //   < 720h → amber    ("aging"  ≤ 1 month)
  //   ≥ 720h → rose     ("stale"  > 1 month)
  // Stale rule DBs miss recently disclosed CVEs — this is the single
  // most important trust signal for a continuous scanner.
  let tone = 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30';
  let label = 'current';
  if (ageHours >= 720) {
    tone = 'bg-rose-500/15 text-rose-200 ring-rose-400/30';
    label = 'stale';
  } else if (ageHours >= 168) {
    tone = 'bg-amber-500/15 text-amber-200 ring-amber-400/30';
    label = 'aging';
  } else if (ageHours >= 24) {
    tone = 'bg-cyan-500/15 text-cyan-200 ring-cyan-400/30';
    label = 'fresh';
  }

  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${tone}`}
      title={`Rule/template DB last updated ${formatAge(ageHours)} ago`}
    >
      {label} · {formatAge(ageHours)} old
    </span>
  );
}

// Try the explicit `db_age_hours` first; fall back to deriving from the
// freshest of the three timestamp keys the engine has used over time.
function resolveAgeHours(meta: ToolMeta): number | null {
  if (typeof meta.db_age_hours === 'number' && Number.isFinite(meta.db_age_hours)) {
    return Math.max(0, meta.db_age_hours);
  }
  const tsCandidates = [meta.last_updated, meta.templates_updated_at, meta.db_updated_at]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n));
  if (tsCandidates.length === 0) return null;
  const newest = Math.max(...tsCandidates);
  const hours = (Date.now() - newest) / (1000 * 60 * 60);
  return hours < 0 ? 0 : hours;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  return `${Math.round(months)}mo`;
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shapeAsObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function derive(events: ScanEvent[], runMeta?: RunMeta | null): ToolRow[] {
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, string>();

  for (const ev of events) {
    if (ev.event_type !== 'tool.execution.started') continue;
    const payload = shapeAsObject(ev.payload);
    const inner = shapeAsObject(payload.payload);
    const actor = shapeAsObject(payload.actor);
    const toolName =
      (actor.tool_name as string | undefined) ??
      (inner.tool_name as string | undefined) ??
      'unknown';
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
    // Last-seen — events arrive in ts order from the live subscription,
    // so the latest write wins.
    lastSeen.set(toolName, ev.created_at);
  }

  // Engine-emitted tool meta (run_meta.tools[name]). Forward-compat —
  // we read whatever the engine writes.
  const toolsMeta = shapeAsObject(
    runMeta && typeof runMeta === 'object' ? (runMeta as Record<string, unknown>).tools : undefined,
  );

  const allNames = new Set<string>([...counts.keys(), ...Object.keys(toolsMeta)]);

  const rows: ToolRow[] = [...allNames].map((name) => ({
    name,
    invocations: counts.get(name) ?? 0,
    lastCallAt: lastSeen.get(name) ?? null,
    meta: (toolsMeta[name] as ToolMeta | undefined) ?? null,
  }));

  // Sort: most-used first, ties broken alphabetically. Tools with no
  // invocations but engine-published meta (e.g. a planned-but-unused
  // tool) sink to the bottom.
  rows.sort((a, b) => {
    if (b.invocations !== a.invocations) return b.invocations - a.invocations;
    return a.name.localeCompare(b.name);
  });

  return rows;
}
