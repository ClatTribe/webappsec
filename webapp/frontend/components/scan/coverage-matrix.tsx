'use client';

import { useMemo, useState } from 'react';
import { Grid3X3, Check, X as XIcon, AlertCircle, ChevronRight } from 'lucide-react';
import type { ScanEvent, ScanCoverage, ScanTarget, Finding } from '@/lib/supabase/types';

// Tier I #2 — Coverage matrix view on scan-detail.
//
// A category × tool × result grid that answers, at one glance:
//   - which vulnerability categories did the engine attempt to cover?
//   - which tools did it actually run for each category?
//   - what was the result — found, clean, or inconclusive?
//
// This is the trust signal both auditors and security engineers ask
// for. The amber `CoverageBanner` already tells you "scan was thin";
// this panel tells you *why* — which categories were probed by which
// tools, and which slots are empty.
//
// Data sources (per CLAUDE.md §1 — consume engine-emitted structured
// data, no re-derivation in the wrapper):
//
//   1. `scans.coverage.required` — the categories the engine planned
//      to cover for this scan_mode × target_type. Source of truth for
//      the row set.
//   2. `scans.coverage.covered` / `gaps` — per-category result tier.
//   3. `scan_events` of type `tool.execution.started` — populates the
//      tool column. We bucket each invocation under the closest matching
//      category from `args` (url, endpoint, path, hypothesis, kind).
//   4. `findings` — categorisation by vuln_id prefix gives us the
//      "found" cells. A category with findings is unambiguously covered.
//
// Hidden when there's no coverage report AND no tool execution event —
// older scans / non-pentest target types where the engine doesn't emit
// either signal.

interface Props {
  coverage: ScanCoverage | null;
  events: ScanEvent[];
  targets: ScanTarget[];
  findings: Finding[];
}

type ResultTier = 'found' | 'covered' | 'gap' | 'inconclusive';

interface CategoryRow {
  category: string;
  tools: Map<string, number>;
  findingCount: number;
  result: ResultTier;
}

const RESULT_THEME: Record<
  ResultTier,
  { Icon: typeof Check; cls: string; label: string; tip: string }
> = {
  found: {
    Icon: AlertCircle,
    cls: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    label: 'found',
    tip: 'Engine produced at least one finding in this category.',
  },
  covered: {
    Icon: Check,
    cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30',
    label: 'clean',
    tip: 'Engine ran the relevant probes and found nothing.',
  },
  gap: {
    Icon: XIcon,
    cls: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
    label: 'gap',
    tip: 'Engine did not produce a verdict for this category. Worth a re-scan with a deeper mode.',
  },
  inconclusive: {
    Icon: AlertCircle,
    cls: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    label: 'inconclusive',
    tip: 'Engine attempted probes but could not produce a clean yes/no verdict.',
  },
};

export default function CoverageMatrix({ coverage, events, targets, findings }: Props) {
  const [open, setOpen] = useState(false);

  const rows = useMemo(
    () => deriveCategoryRows(coverage, events, findings),
    [coverage, events, findings],
  );

  if (rows.length === 0) return null;

  const found = rows.filter((r) => r.result === 'found').length;
  const clean = rows.filter((r) => r.result === 'covered').length;
  const gaps = rows.filter((r) => r.result === 'gap').length;
  const inconclusive = rows.filter((r) => r.result === 'inconclusive').length;

  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-neutral-900/50"
      >
        <div className="flex items-center gap-2.5">
          <ChevronRight
            className={`h-3.5 w-3.5 text-neutral-500 transition-transform ${open ? 'rotate-90 text-neutral-300' : ''}`}
            strokeWidth={2.5}
          />
          <Grid3X3 className="h-3.5 w-3.5 text-violet-300/80" strokeWidth={2.25} />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Coverage matrix
          </h2>
          <span
            className="text-[10.5px] text-neutral-500"
            title="Per-category breakdown of what the engine probed, which tool it used, and what verdict it produced."
          >
            {rows.length} categor{rows.length === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10.5px]">
          {found > 0 && <Pill tone="rose">{found} found</Pill>}
          {clean > 0 && <Pill tone="emerald">{clean} clean</Pill>}
          {inconclusive > 0 && <Pill tone="zinc">{inconclusive} inconclusive</Pill>}
          {gaps > 0 && <Pill tone="amber">{gaps} gap{gaps === 1 ? '' : 's'}</Pill>}
        </div>
      </button>
      {open && (
        <div className="border-t border-neutral-800/60 bg-neutral-950/30">
          {targets.length > 1 && (
            <div className="border-b border-neutral-800/60 px-5 py-2 text-[10.5px] text-neutral-500">
              Aggregated across {targets.length} target{targets.length === 1 ? '' : 's'}.
              Engine doesn't emit per-target coverage yet (engine wishlist) — re-scan
              individually for target-level breakdown.
            </div>
          )}
          <ul className="divide-y divide-neutral-800/60">
            {rows.map((r) => (
              <CategoryRowView key={r.category} row={r} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CategoryRowView({ row }: { row: CategoryRow }) {
  const theme = RESULT_THEME[row.result];
  const tools = [...row.tools.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <li className="grid grid-cols-[10rem_1fr_auto] items-start gap-4 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-neutral-200">{row.category}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {tools.length === 0 ? (
          <span className="text-[11px] italic text-neutral-600">no tool fired</span>
        ) : (
          tools.map(([name, count]) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-900/80 px-1.5 py-0.5 text-[10.5px] ring-1 ring-neutral-800"
            >
              <span className="font-mono text-amber-300/90">{name}</span>
              <span className="font-mono text-neutral-500">×{count}</span>
            </span>
          ))
        )}
      </div>
      <div className="flex items-center gap-2">
        {row.findingCount > 0 && (
          <span className="text-[10.5px] text-rose-300/80" title="Findings emitted in this category">
            {row.findingCount} finding{row.findingCount === 1 ? '' : 's'}
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ring-1 ${theme.cls}`}
          title={theme.tip}
        >
          <theme.Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
          {theme.label}
        </span>
      </div>
    </li>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: 'rose' | 'emerald' | 'amber' | 'zinc' }) {
  const cls = {
    rose: 'bg-rose-500/15 text-rose-200',
    emerald: 'bg-emerald-500/15 text-emerald-200',
    amber: 'bg-amber-500/15 text-amber-200',
    zinc: 'bg-neutral-700/40 text-neutral-300',
  }[tone];
  return <span className={`rounded-md px-1.5 py-0.5 font-medium ${cls}`}>{children}</span>;
}

function shapeAsObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Engine's vuln_id prefix → coverage category. Mirrors Strix's category
// vocabulary in `strix/scan_categories.py` so the wrapper stays a thin
// layer (CLAUDE.md §1.2 — mirror Strix's data model). The fallback is
// the lowercased prefix itself, which keeps a future engine category
// working zero-day in the UI.
function vulnIdToCategory(vulnId: string | null | undefined): string | null {
  if (!vulnId) return null;
  const prefix = vulnId.split('-')[0]?.toLowerCase();
  if (!prefix) return null;
  return prefix;
}

// Tool args may carry a `kind`, `hypothesis`, or `category` key the
// engine sets to the category being probed (engine PR #138 onward).
// When present this is authoritative; otherwise we infer from tool name
// (e.g. `scan_sqli` → `sqli`).
function eventCategory(payload: Record<string, unknown>, actor: Record<string, unknown>, toolName: string): string | null {
  const inner = shapeAsObject(payload.payload);
  const args = shapeAsObject(inner.args);
  for (const k of ['category', 'kind', 'hypothesis_kind', 'vuln_kind']) {
    const v = args[k] ?? inner[k] ?? actor[k];
    if (typeof v === 'string' && v.trim()) return v.toLowerCase();
  }
  // Tool-name heuristic: `scan_xss` / `probe_sqli` / `xss_specialist` → category
  // (the engine names specialists after the category they own).
  const m = toolName.toLowerCase().match(/^(?:scan|probe|check|test)?_?([a-z][a-z0-9_]+?)(?:_specialist|_check)?$/);
  if (m && m[1]) {
    const guess = m[1].replace(/[-_]/g, '');
    // Skip pure-noun tool names that aren't categories (curl, fetch, browse).
    if (!['curl', 'fetch', 'browse', 'navigate', 'screenshot', 'wait', 'sleep'].includes(guess)) {
      return guess;
    }
  }
  return null;
}

function deriveCategoryRows(
  coverage: ScanCoverage | null,
  events: ScanEvent[],
  findings: Finding[],
): CategoryRow[] {
  const required = new Set<string>(
    Array.isArray(coverage?.required)
      ? coverage!.required!.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase())
      : [],
  );
  const covered = new Set<string>(
    Array.isArray(coverage?.covered)
      ? coverage!.covered!.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase())
      : [],
  );
  const gaps = new Set<string>(
    Array.isArray(coverage?.gaps)
      ? coverage!.gaps!.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase())
      : [],
  );

  const byCat = new Map<string, CategoryRow>();
  const ensure = (cat: string): CategoryRow => {
    let row = byCat.get(cat);
    if (!row) {
      row = { category: cat, tools: new Map(), findingCount: 0, result: 'gap' };
      byCat.set(cat, row);
    }
    return row;
  };

  for (const cat of required) ensure(cat);

  // Tool invocations by category (from events).
  for (const ev of events) {
    if (ev.event_type !== 'tool.execution.started') continue;
    const payload = shapeAsObject(ev.payload);
    const actor = shapeAsObject(payload.actor);
    const inner = shapeAsObject(payload.payload);
    const toolName =
      (actor.tool_name as string | undefined) ??
      (inner.tool_name as string | undefined) ??
      'unknown';
    const cat = eventCategory(payload, actor, toolName);
    if (!cat) continue;
    // Only credit toward known/required categories OR new categories the
    // engine emitted that coverage didn't pre-declare. (We add new cats so
    // future engine extensions surface without a wrapper update.)
    const row = ensure(cat);
    row.tools.set(toolName, (row.tools.get(toolName) ?? 0) + 1);
  }

  // Finding counts by category (from findings.vuln_id).
  for (const f of findings) {
    const cat = vulnIdToCategory(f.vuln_id);
    if (!cat) continue;
    if (!required.has(cat) && !byCat.has(cat)) continue;
    const row = ensure(cat);
    row.findingCount += 1;
  }

  // Resolve result tier per row. Precedence:
  //   findings > engine-declared covered > tool fired > gap.
  for (const row of byCat.values()) {
    if (row.findingCount > 0) {
      row.result = 'found';
    } else if (covered.has(row.category)) {
      row.result = 'covered';
    } else if (gaps.has(row.category)) {
      row.result = 'gap';
    } else if (row.tools.size > 0) {
      // Tool fired but no verdict signal — inconclusive.
      row.result = 'inconclusive';
    } else {
      row.result = 'gap';
    }
  }

  // Sort: found (most-severe-first) → inconclusive → covered → gap.
  // Stable secondary by category name for deterministic render.
  const tierOrder: Record<ResultTier, number> = {
    found: 0,
    inconclusive: 1,
    covered: 2,
    gap: 3,
  };
  return [...byCat.values()].sort((a, b) => {
    const t = tierOrder[a.result] - tierOrder[b.result];
    if (t !== 0) return t;
    if (a.result === 'found' && b.result === 'found') {
      // findings desc within found tier.
      if (b.findingCount !== a.findingCount) return b.findingCount - a.findingCount;
    }
    return a.category.localeCompare(b.category);
  });
}
