'use client';

import { useMemo, useState } from 'react';
import {
  Bot,
  Wrench,
  Crosshair,
  ChevronRight,
  CheckCircle2,
  Activity,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

interface AgentToolCall {
  tool_name: string;
  args: Record<string, unknown>;
  ts: string;
}

interface AgentSummary {
  id: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  tool_calls: AgentToolCall[];
}

interface DerivedReview {
  agents: AgentSummary[];
  toolCounts: Array<{ tool_name: string; count: number }>;
  attackSurface: Array<{ value: string; count: number }>;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'errored', 'finished']);

function shapeAsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function deriveReview(events: ScanEvent[]): DerivedReview {
  const agentMap = new Map<string, AgentSummary>();
  const toolCounts = new Map<string, number>();
  const surfaceCounts = new Map<string, number>();

  // Lenient agent registration: any agent_id seen anywhere (created, status,
  // or as a tool actor) creates an entry. Strix's older runs don't always emit
  // `agent.created`, but they always emit `tool.execution.started` with the
  // agent in `actor`.
  const ensureAgent = (agentId: string, name?: string, task?: string): AgentSummary => {
    let a = agentMap.get(agentId);
    if (!a) {
      a = {
        id: agentId,
        name: name && name.trim() ? name : agentId,
        task: task ?? '',
        status: 'unknown',
        tool_calls: [],
      };
      agentMap.set(agentId, a);
    } else {
      // Fill in missing name/task opportunistically from a later event.
      if (name && name.trim() && a.name === a.id) a.name = name;
      if (task && !a.task) a.task = task;
    }
    return a;
  };

  for (const ev of events) {
    const payload = shapeAsObject(ev.payload);
    const actor = shapeAsObject(payload.actor);
    const innerPayload = shapeAsObject(payload.payload);

    if (ev.event_type === 'agent.created') {
      const agentId =
        (innerPayload.agent_id as string | undefined) ??
        (actor.agent_id as string | undefined) ??
        (payload.agent_id as string | undefined) ??
        `agent-${agentMap.size}`;
      const name =
        (actor.agent_name as string | undefined) ??
        (innerPayload.name as string | undefined);
      const task =
        (innerPayload.task as string | undefined) ??
        (payload.task as string | undefined);
      const a = ensureAgent(agentId, name, task);
      // agent.created -> known to be running until a status event flips it.
      if (a.status === 'unknown') a.status = 'running';
    } else if (ev.event_type === 'agent.status.updated') {
      const agentId =
        (actor.agent_id as string | undefined) ??
        (innerPayload.agent_id as string | undefined);
      if (!agentId) continue;
      const a = ensureAgent(agentId, actor.agent_name as string | undefined);
      const status = String(payload.status ?? '').toLowerCase();
      if (status === 'running') {
        a.status = 'running';
      } else if (TERMINAL_STATUSES.has(status)) {
        a.status =
          status === 'completed' || status === 'finished' ? 'completed' : 'failed';
      }
    } else if (ev.event_type === 'tool.execution.started') {
      const toolName =
        (actor.tool_name as string | undefined) ??
        (innerPayload.tool_name as string | undefined) ??
        'unknown';
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

      const args = shapeAsObject(innerPayload.args);
      for (const key of ['url', 'endpoint', 'target', 'path']) {
        const v = args[key];
        if (typeof v === 'string' && v.trim()) {
          surfaceCounts.set(v, (surfaceCounts.get(v) ?? 0) + 1);
        }
      }
      const agentId = actor.agent_id as string | undefined;
      if (agentId) {
        const a = ensureAgent(agentId, actor.agent_name as string | undefined);
        a.tool_calls.push({
          tool_name: toolName,
          args,
          ts: ev.created_at,
        });
      }
    }
  }

  return {
    agents: [...agentMap.values()],
    toolCounts: [...toolCounts.entries()]
      .map(([tool_name, count]) => ({ tool_name, count }))
      .sort((a, b) => b.count - a.count || a.tool_name.localeCompare(b.tool_name)),
    attackSurface: [...surfaceCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
}

const STATUS_PILL: Record<AgentSummary['status'], { Icon: LucideIcon; cls: string; label: string }> = {
  running: { Icon: Activity, cls: 'bg-blue-500/15 text-blue-200 ring-blue-500/30', label: 'Running' },
  completed: {
    Icon: CheckCircle2,
    cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    label: 'Done',
  },
  failed: { Icon: XCircle, cls: 'bg-red-500/15 text-red-200 ring-red-500/30', label: 'Failed' },
  unknown: {
    Icon: Activity,
    cls: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    label: '—',
  },
};

export default function SecurityReview({ events }: { events: ScanEvent[] }) {
  const review = useMemo(() => deriveReview(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hasAnything =
    review.agents.length > 0 || review.toolCounts.length > 0 || review.attackSurface.length > 0;

  if (!hasAnything) {
    return (
      <section className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-neutral-300">
          <Bot className="h-4 w-4 text-neutral-400" strokeWidth={2} />
          Security review
        </div>
        <p className="mt-2 text-sm text-neutral-400">
          Waiting for agents… The scan will list each agent, the tools it ran, and the surface it
          touched here as it works.
        </p>
      </section>
    );
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const maxToolCount = review.toolCounts[0]?.count ?? 0;
  const maxSurfaceCount = review.attackSurface[0]?.count ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          Security review
        </h2>
        <span className="text-xs text-neutral-500">
          {review.agents.length} agent{review.agents.length === 1 ? '' : 's'} ·{' '}
          {review.toolCounts.reduce((s, t) => s + t.count, 0)} tool call
          {review.toolCounts.length === 1 ? '' : 's'} · {review.attackSurface.length} surface
          {review.attackSurface.length === 1 ? '' : 's'}
        </span>
      </div>

      {review.agents.length > 0 && (
        <div className="space-y-2">
          <SubHeader icon={Bot} label="Agents" />
          <div className="space-y-2">
            {review.agents.map((agent) => {
              const isOpen = expanded.has(agent.id);
              const pill = STATUS_PILL[agent.status];
              const PillIcon = pill.Icon;
              return (
                <div
                  key={agent.id}
                  className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 transition-colors hover:border-neutral-700"
                >
                  <button
                    type="button"
                    onClick={() => agent.tool_calls.length > 0 && toggle(agent.id)}
                    className={`flex w-full items-start gap-3 p-4 text-left ${
                      agent.tool_calls.length > 0 ? 'cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    <ChevronRight
                      className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-neutral-600 transition-transform ${
                        agent.tool_calls.length === 0 ? 'invisible' : ''
                      } ${isOpen ? 'rotate-90 text-neutral-300' : ''}`}
                      strokeWidth={2.5}
                    />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-neutral-100">
                          {agent.name}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${pill.cls}`}
                        >
                          <PillIcon className="h-3 w-3" strokeWidth={2.5} />
                          {pill.label}
                        </span>
                        {agent.tool_calls.length > 0 && (
                          <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">
                            {agent.tool_calls.length} tool call
                            {agent.tool_calls.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                      {agent.task && (
                        <p className="text-sm leading-relaxed text-neutral-300">
                          {agent.task}
                        </p>
                      )}
                    </div>
                  </button>
                  {isOpen && agent.tool_calls.length > 0 && (
                    <div className="border-t border-neutral-800/60 bg-neutral-950/40 px-4 py-3">
                      <ol className="space-y-1.5">
                        {agent.tool_calls.map((c, i) => (
                          <li
                            key={`${c.ts}-${i}`}
                            className="flex items-center gap-2 font-mono text-[11.5px]"
                          >
                            <span className="w-6 flex-shrink-0 text-right text-neutral-600">
                              {i + 1}.
                            </span>
                            <span className="text-amber-300/90">{c.tool_name}</span>
                            <span className="min-w-0 flex-1 truncate text-neutral-500">
                              {summariseArgs(c.args)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {review.toolCounts.length > 0 && (
          <div className="space-y-2">
            <SubHeader icon={Wrench} label="Tools used" />
            <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3">
              <ul className="space-y-1.5">
                {review.toolCounts.map((t) => (
                  <li key={t.tool_name} className="grid grid-cols-[1fr_auto] items-center gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[12px] text-neutral-200">
                          {t.tool_name}
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-neutral-400">
                          {t.count}
                        </span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full bg-amber-400/60"
                          style={{
                            width: `${Math.max(4, (t.count / maxToolCount) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {review.attackSurface.length > 0 && (
          <div className="space-y-2">
            <SubHeader icon={Crosshair} label="Attack surface touched" />
            <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3">
              <ul className="space-y-1.5">
                {review.attackSurface.slice(0, 50).map((s) => (
                  <li
                    key={s.value}
                    className="flex items-center justify-between gap-3 font-mono text-[11.5px]"
                    title={s.value}
                  >
                    <span className="min-w-0 flex-1 truncate text-neutral-300">{s.value}</span>
                    <span className="flex-shrink-0 rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-400">
                      {s.count}×
                    </span>
                    <div className="hidden h-1 w-16 flex-shrink-0 overflow-hidden rounded-full bg-neutral-800 sm:block">
                      <div
                        className="h-full bg-cyan-400/60"
                        style={{
                          width: `${Math.max(4, (s.count / maxSurfaceCount) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
                {review.attackSurface.length > 50 && (
                  <li className="pt-1 text-[10px] text-neutral-500">
                    + {review.attackSurface.length - 50} more
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function SubHeader({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      {label}
    </div>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  for (const key of ['url', 'endpoint', 'target', 'path', 'command']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const firstKey = keys[0];
  const firstVal = args[firstKey];
  if (typeof firstVal === 'string') return `${firstKey}=${firstVal}`;
  return keys.join(', ');
}
