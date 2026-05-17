'use client';

import { useMemo } from 'react';
import {
  CheckCircle2,
  Activity,
  Search,
  Bug,
  ShieldCheck,
  FileText,
  AlertTriangle,
  Circle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

// PhaseProgress — engine §15.4 / wishlist §15.4 / engine PR #140.
//
// Renders the four canonical phases as a horizontal progress strip:
//   recon → exploit → validate → report
//
// Each tile shows entered/completed status, the categories the engine
// reported as covered (from `agent.self_audit.categories_covered`), and
// — when present — a compact gate-breach banner with `categories_skipped`
// + the engine's `concern` field. Helps operators answer:
//   "Did the engine actually complete a full phase set?"
//   "Were any categories silently skipped?"
//
// Source events:
//   - phase.entered / phase.completed (engine PR #35)
//   - agent.self_audit (engine PR #140) — emitted between phases
//
// Renders nothing when no phase events exist (older engine versions or
// scans that haven't started). The component is the read-only consumer
// of structured engine signals — per Architecture.md §1.1 we never
// re-derive phase state from the log stream.

const CANONICAL_PHASES = ['recon', 'exploit', 'validate', 'report'] as const;
type CanonicalPhase = (typeof CANONICAL_PHASES)[number];

const PHASE_THEME: Record<
  CanonicalPhase,
  { Icon: LucideIcon; label: string; description: string }
> = {
  recon:    { Icon: Search,      label: 'Recon',    description: 'Map the surface' },
  exploit:  { Icon: Bug,         label: 'Exploit',  description: 'Probe for vulnerabilities' },
  validate: { Icon: ShieldCheck, label: 'Validate', description: 'Confirm exploitability' },
  report:   { Icon: FileText,    label: 'Report',   description: 'Compose findings' },
};

type PhaseStatus = 'pending' | 'entered' | 'completed';

interface PhaseState {
  name: string;
  canonical: CanonicalPhase | null;
  status: PhaseStatus;
  entered_at: string | null;
  completed_at: string | null;
  /** Categories covered as reported by the most recent self_audit
   *  whose `phase_completed` matches this phase. */
  categories_covered: string[];
  /** Skipped categories — same source. Surfacing these is the gate-breach
   *  signal in the wishlist. */
  categories_skipped: string[];
  /** Operator-facing reason text from the self-audit. */
  concern: string | null;
  /** Sub-agents the engine flagged as stuck during this phase. */
  stuck_sub_agents: string[];
}

function shapeAsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function asStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function normalisePhaseName(raw: string): { canonical: CanonicalPhase | null; display: string } {
  const lower = raw.toLowerCase().trim();
  for (const c of CANONICAL_PHASES) {
    if (lower === c || lower.startsWith(c)) return { canonical: c, display: raw };
  }
  return { canonical: null, display: raw };
}

function derivePhases(events: ScanEvent[]): PhaseState[] {
  const byName = new Map<string, PhaseState>();

  const ensure = (name: string): PhaseState => {
    let p = byName.get(name);
    if (!p) {
      const { canonical } = normalisePhaseName(name);
      p = {
        name,
        canonical,
        status: 'pending',
        entered_at: null,
        completed_at: null,
        categories_covered: [],
        categories_skipped: [],
        concern: null,
        stuck_sub_agents: [],
      };
      byName.set(name, p);
    }
    return p;
  };

  for (const ev of events) {
    const payload = shapeAsObject(ev.payload);
    const inner = shapeAsObject(payload.payload);

    if (ev.event_type === 'phase.entered') {
      // Field name drift over time: the engine has used `phase_name`
      // (older PR #35), `phase` (current §2 OPPLAN state machine,
      // strix PR #239), and `status` (newest events also carry the
      // phase identifier here). We accept all three so older recorded
      // scans still render and newer engine versions don't silently
      // produce a blank coverage receipt.
      const phaseName =
        (inner.phase_name as string | undefined) ??
        (payload.phase_name as string | undefined) ??
        (inner.phase as string | undefined) ??
        (payload.phase as string | undefined) ??
        (typeof payload.status === 'string' ? payload.status : undefined);
      if (!phaseName) continue;
      const p = ensure(phaseName);
      if (p.status === 'pending') p.status = 'entered';
      if (!p.entered_at) p.entered_at = ev.created_at;
    } else if (ev.event_type === 'phase.completed') {
      const phaseName =
        (inner.phase_name as string | undefined) ??
        (payload.phase_name as string | undefined) ??
        (inner.phase as string | undefined) ??
        (payload.phase as string | undefined) ??
        (typeof payload.status === 'string' ? payload.status : undefined);
      if (!phaseName) continue;
      const p = ensure(phaseName);
      p.status = 'completed';
      p.completed_at = ev.created_at;
    } else if (ev.event_type === 'agent.self_audit') {
      // Self-audit fires *between* phases, attributed to the just-completed
      // one via `phase_completed`. We attach the engine's coverage report
      // to that phase. Multiple audits can fire — last write wins, which
      // matches the engine's own monotonic auditing model.
      const phaseCompleted = (inner.phase_completed as string | undefined)
        ?? (payload.phase_completed as string | undefined);
      if (!phaseCompleted) continue;
      const p = ensure(phaseCompleted);
      p.categories_covered = asStringArray(inner.categories_covered ?? payload.categories_covered);
      p.categories_skipped = asStringArray(inner.categories_skipped ?? payload.categories_skipped);
      p.stuck_sub_agents = asStringArray(inner.stuck_sub_agents ?? payload.stuck_sub_agents);
      const concern = (inner.concern as string | undefined) ?? (payload.concern as string | undefined);
      p.concern = concern && concern.trim() ? concern : null;
    }
  }

  // Order: canonical phases first in canonical order, then any
  // engine-emitted phase that didn't match the canonical names (defensive
  // — older or future engines might use different labels).
  const known: PhaseState[] = [];
  const seen = new Set<string>();
  for (const c of CANONICAL_PHASES) {
    const match = [...byName.values()].find((p) => p.canonical === c);
    if (match) {
      known.push(match);
      seen.add(match.name);
    }
  }
  for (const p of byName.values()) {
    if (!seen.has(p.name)) known.push(p);
  }
  return known;
}

export default function PhaseProgress({ events }: { events: ScanEvent[] }) {
  const phases = useMemo(() => derivePhases(events), [events]);

  if (phases.length === 0) return null;

  const breaches = phases.filter(
    (p) => p.categories_skipped.length > 0 || p.stuck_sub_agents.length > 0,
  );

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          Coverage receipt
        </h2>
        <span
          className="text-[10.5px] text-neutral-500"
          title="Per-phase coverage from the engine's self-audit (engine PR #140). Surfaces silently-skipped categories so 'did the engine complete a full phase set?' has a yes/no answer."
        >
          {phases.filter((p) => p.status === 'completed').length} of {phases.length} phase
          {phases.length === 1 ? '' : 's'} done
        </span>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {phases.map((p) => (
          <PhaseTile key={p.name} phase={p} />
        ))}
      </ol>

      {breaches.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-300" strokeWidth={2.5} />
            <span className="text-[12px] font-medium text-amber-100">
              Self-audit gate breach — {breaches.length} phase
              {breaches.length === 1 ? '' : 's'} flagged
            </span>
          </div>
          <ul className="space-y-1.5 pl-5 text-[11.5px] text-amber-200/80">
            {breaches.map((p) => (
              <li key={p.name} className="leading-relaxed">
                <span className="font-medium text-amber-100">{p.name}</span>
                {p.categories_skipped.length > 0 && (
                  <>
                    {' '}— skipped:{' '}
                    <span className="font-mono">{p.categories_skipped.join(', ')}</span>
                  </>
                )}
                {p.stuck_sub_agents.length > 0 && (
                  <>
                    {' '}— stuck:{' '}
                    <span className="font-mono">{p.stuck_sub_agents.join(', ')}</span>
                  </>
                )}
                {p.concern && (
                  <span className="text-amber-200/60"> · {p.concern}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PhaseTile({ phase }: { phase: PhaseState }) {
  const theme = phase.canonical ? PHASE_THEME[phase.canonical] : null;
  const Icon = theme?.Icon ?? Circle;
  const label = theme?.label ?? phase.name;
  const description = theme?.description ?? '';

  const ringByStatus: Record<PhaseStatus, string> = {
    pending: 'border-neutral-800/80 bg-neutral-900/30',
    entered: 'border-blue-500/40 bg-blue-500/[0.05]',
    completed: 'border-emerald-500/30 bg-emerald-500/[0.04]',
  };
  const iconColor: Record<PhaseStatus, string> = {
    pending: 'text-neutral-600',
    entered: 'text-blue-300',
    completed: 'text-emerald-300',
  };

  return (
    <li className={`rounded-xl border p-3 ${ringByStatus[phase.status]}`}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex-shrink-0">
          {phase.status === 'completed' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-300" strokeWidth={2.25} />
          ) : phase.status === 'entered' ? (
            <Activity className="h-4 w-4 text-blue-300" strokeWidth={2.25} />
          ) : (
            <Icon className={`h-4 w-4 ${iconColor[phase.status]}`} strokeWidth={2.25} />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12.5px] font-semibold text-neutral-200">{label}</span>
            <span className="text-[10.5px] uppercase tracking-wider text-neutral-500">
              {phase.status === 'completed'
                ? 'done'
                : phase.status === 'entered'
                  ? 'in progress'
                  : 'pending'}
            </span>
          </div>
          {description && (
            <p className="text-[11px] leading-relaxed text-neutral-500">{description}</p>
          )}
          {phase.categories_covered.length > 0 && (
            <div className="pt-1">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Covered ({phase.categories_covered.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {phase.categories_covered.slice(0, 8).map((cat) => (
                  <span
                    key={cat}
                    className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200/90 ring-1 ring-emerald-400/20"
                  >
                    {cat}
                  </span>
                ))}
                {phase.categories_covered.length > 8 && (
                  <span className="rounded bg-neutral-800/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                    +{phase.categories_covered.length - 8}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
