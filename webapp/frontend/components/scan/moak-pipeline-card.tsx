'use client';

import { useMemo } from 'react';
import {
  Search,
  Wrench,
  Zap,
  ShieldCheck,
  Radio,
  ChevronRight,
  CircleDashed,
  Loader2,
} from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

// Wishlist §18.7 — MOAK pipeline-phase live view.
//
// Engine PR #270 ships production agent bodies for the full MOAK
// pipeline. Each agent emits `tool.execution.started` / `_updated` /
// `_finished` events with the agent name visible in the tool name
// or actor block. We bucket those events into the 5 canonical
// stages so the operator can watch the pipeline drive a CVE
// candidate → live verification at a glance:
//
//   Researcher → EnvironmentBuilder → Exploiter → Judge → LiveProbe
//
// Engine PR #278 added the LiveProbe stage (gated by the
// STRIX_MOAK_LIVE_PROBE feature flag per-target — see the consent
// toggle on the target form).
//
// Hidden when no MOAK events have fired on this scan. Non-cloud /
// non-API scans don't even invoke MOAK so the card stays out of
// the way.

type StageId = 'researcher' | 'builder' | 'exploiter' | 'judge' | 'live_probe';

const STAGES: Array<{ id: StageId; label: string; Icon: typeof Search; tip: string }> = [
  { id: 'researcher',  label: 'Researcher',  Icon: Search,      tip: 'Maps fingerprinted products → CVE candidates' },
  { id: 'builder',     label: 'Builder',     Icon: Wrench,      tip: 'Spins up a reference container with the vulnerable version' },
  { id: 'exploiter',   label: 'Exploiter',   Icon: Zap,         tip: 'Generates + runs the exploit script inside the sandbox' },
  { id: 'judge',       label: 'Judge',       Icon: ShieldCheck, tip: 'Adjudicates outcome (flag captured / artifact pulled / rejected paths)' },
  { id: 'live_probe',  label: 'LiveProbe',   Icon: Radio,       tip: 'Replays verified exploit against the production target — gated by STRIX_MOAK_LIVE_PROBE' },
];

interface StageStat {
  /** Number of agent invocations the stage saw. */
  invocations: number;
  /** Number of started events with no matching finished event yet. */
  running: number;
  /** Number of finished events. */
  finished: number;
  /** Number of finished events with success=true (when emitted). */
  succeeded: number;
}

interface Props {
  events: ScanEvent[];
}

export default function MoakPipelineCard({ events }: Props) {
  const stats = useMemo(() => deriveStageStats(events), [events]);

  // Hide when no MOAK activity at all.
  const anyActivity = STAGES.some((s) => stats[s.id].invocations > 0);
  if (!anyActivity) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-violet-500/20 bg-gradient-to-b from-violet-500/[0.04] to-violet-500/[0.01] p-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Zap className="h-4 w-4 text-violet-300" strokeWidth={2.25} />
          <h2 className="text-sm font-medium uppercase tracking-wider text-violet-200">
            MOAK exploit-synthesis pipeline
          </h2>
        </div>
        <span className="text-[10.5px] text-violet-200/70">
          engine PRs #270 / #278 — Researcher → Builder → Exploiter → Judge → LiveProbe
        </span>
      </header>

      <ol className="grid grid-cols-5 gap-1.5">
        {STAGES.map((stage, i) => (
          <StageColumn key={stage.id} stage={stage} stat={stats[stage.id]} isLast={i === STAGES.length - 1} />
        ))}
      </ol>

      <p className="text-[10.5px] leading-relaxed text-violet-200/60">
        Each stage shows agent invocations · running · succeeded. Live-probe
        runs only when the per-target consent toggle is on (
        <code className="font-mono">targets.config.allow_live_probe = true</code>)
        and the engine's <code className="font-mono">STRIX_MOAK_LIVE_PROBE=1</code> feature flag is set.
      </p>
    </section>
  );
}

function StageColumn({
  stage,
  stat,
  isLast,
}: {
  stage: (typeof STAGES)[number];
  stat: StageStat;
  isLast: boolean;
}) {
  const status: 'idle' | 'running' | 'done' =
    stat.running > 0 ? 'running' : stat.finished > 0 ? 'done' : 'idle';

  const tone =
    status === 'running'
      ? 'border-violet-500/40 bg-violet-500/15 text-violet-100'
      : status === 'done'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
        : 'border-neutral-800 bg-neutral-900/30 text-neutral-500';

  return (
    <li className="relative flex flex-col items-stretch">
      <div className={`relative space-y-1.5 rounded-lg border px-3 py-2.5 ${tone}`}>
        <div className="flex items-center gap-1.5">
          {status === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
          ) : status === 'done' ? (
            <stage.Icon className="h-3 w-3" strokeWidth={2.5} />
          ) : (
            <CircleDashed className="h-3 w-3" strokeWidth={2.5} />
          )}
          <span
            className="truncate text-[11px] font-semibold uppercase tracking-wider"
            title={stage.tip}
          >
            {stage.label}
          </span>
        </div>
        <div className="space-y-0.5 text-[10px] leading-tight">
          <div>
            <span className="opacity-60">invocations</span>{' '}
            <span className="font-mono font-semibold">{stat.invocations}</span>
          </div>
          {stat.running > 0 && (
            <div className="text-violet-100">
              <span className="opacity-60">running</span>{' '}
              <span className="font-mono font-semibold">{stat.running}</span>
            </div>
          )}
          {stat.finished > 0 && (
            <div>
              <span className="opacity-60">done</span>{' '}
              <span className="font-mono font-semibold">{stat.finished}</span>
              {stat.succeeded > 0 && stat.succeeded < stat.finished && (
                <span className="opacity-60"> ({stat.succeeded} ✓)</span>
              )}
            </div>
          )}
        </div>
      </div>
      {!isLast && (
        <ChevronRight
          className="absolute -right-2 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-violet-300/40"
          strokeWidth={2.5}
        />
      )}
    </li>
  );
}

// =============== event → stage mapping ============================
//
// MOAK agents emit tool.execution.* events with a tool name carrying
// the agent identifier. The exact format varies across engine versions
// — we match defensively on several substrings. Mis-matches are
// silently dropped so a future tool name doesn't break the card.

function shapeAsObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function classifyEvent(eventType: string, toolName: string): StageId | null {
  if (eventType.startsWith('tool.execution.') === false) return null;
  const t = toolName.toLowerCase();
  if (!t) return null;
  if (t.includes('researcher') || t.includes('cve_candidate') || t.includes('moak_research')) {
    return 'researcher';
  }
  if (t.includes('environment') || t.includes('builder') || t.includes('moak_build')) {
    return 'builder';
  }
  if (t.includes('exploiter') || t.includes('exploit_runner') || t.includes('moak_exploit')) {
    return 'exploiter';
  }
  if (t.includes('judge') || t.includes('poc_grader') || t.includes('moak_judge')) {
    return 'judge';
  }
  if (t.includes('live_probe') || t.includes('liveprobe') || t.includes('moak_live')) {
    return 'live_probe';
  }
  return null;
}

function deriveStageStats(events: ScanEvent[]): Record<StageId, StageStat> {
  const init: StageStat = { invocations: 0, running: 0, finished: 0, succeeded: 0 };
  const out: Record<StageId, StageStat> = {
    researcher: { ...init },
    builder: { ...init },
    exploiter: { ...init },
    judge: { ...init },
    live_probe: { ...init },
  };

  // Track running invocations via execution-id. tool.execution.started
  // increments running; tool.execution.finished decrements.
  const runningByExecId = new Map<string, StageId>();

  for (const ev of events) {
    const payload = shapeAsObject(ev.payload);
    const inner = shapeAsObject(payload.payload);
    const actor = shapeAsObject(payload.actor);
    const toolName =
      (actor.tool_name as string | undefined) ??
      (inner.tool_name as string | undefined) ??
      '';
    const stage = classifyEvent(ev.event_type, toolName);
    if (!stage) continue;

    const execId =
      (actor.execution_id as string | undefined) ??
      (inner.execution_id as string | undefined) ??
      `${ev.id}`;

    if (ev.event_type === 'tool.execution.started') {
      out[stage].invocations += 1;
      out[stage].running += 1;
      runningByExecId.set(execId, stage);
    } else if (ev.event_type === 'tool.execution.finished') {
      out[stage].finished += 1;
      // success flag may be on either payload location
      const success =
        (inner.success as boolean | undefined) ??
        (payload.success as boolean | undefined);
      if (success === true) out[stage].succeeded += 1;

      const trackedStage = runningByExecId.get(execId);
      if (trackedStage) {
        out[trackedStage].running = Math.max(0, out[trackedStage].running - 1);
        runningByExecId.delete(execId);
      }
    }
  }

  return out;
}
