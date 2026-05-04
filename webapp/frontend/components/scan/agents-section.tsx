'use client';

import { useMemo, useState } from 'react';
import {
  Bot,
  Activity,
  CheckCircle2,
  XCircle,
  Wrench,
  Info,
  ChevronRight,
  Search,
  KeyRound,
  Bug,
  Globe,
  Network,
  FileCode,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

interface AgentSummary {
  id: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  toolCalls: Array<{ tool_name: string; surface: string | null; ts: string }>;
  /** Engine-deterministic role tag from `agent.created.payload.category`
   *  (engine PR #33). One of `auth-attacker`, `webapp-attacker`,
   *  `sqli-validator`, `xss-specialist`, `ssrf-scanner`, `webapp-recon`,
   *  etc. When set, the UI uses this directly and skips the heuristic. */
  engineCategory: string | null;
}

const TERMINAL_DONE = new Set(['completed', 'finished']);
const TERMINAL_FAILED = new Set(['failed', 'errored', 'error']);

function shapeAsObject(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function deriveAgents(events: ScanEvent[]): AgentSummary[] {
  const map = new Map<string, AgentSummary>();

  const ensure = (id: string, name?: string, task?: string, engineCategory?: string): AgentSummary => {
    let a = map.get(id);
    if (!a) {
      a = {
        id,
        name: name && name.trim() ? name : id,
        task: task ?? '',
        status: 'unknown',
        toolCalls: [],
        engineCategory: engineCategory ?? null,
      };
      map.set(id, a);
    } else {
      if (name && name.trim() && a.name === a.id) a.name = name;
      if (task && !a.task) a.task = task;
      if (engineCategory && !a.engineCategory) a.engineCategory = engineCategory;
    }
    return a;
  };

  for (const ev of events) {
    const payload = shapeAsObject(ev.payload);
    const actor = shapeAsObject(payload.actor);
    const innerPayload = shapeAsObject(payload.payload);

    if (ev.event_type === 'agent.created') {
      const id =
        (innerPayload.agent_id as string | undefined) ??
        (actor.agent_id as string | undefined) ??
        (payload.agent_id as string | undefined);
      if (!id) continue;
      // Engine PR #33: agent.created.payload.category — deterministic role
      // tag like `auth-attacker`, `ssrf-scanner`. Wrapper-side heuristic
      // (`inferAgentCategory` below) is the fallback when this is null.
      const engineCategory =
        (innerPayload.category as string | undefined) ??
        (payload.category as string | undefined) ??
        (actor.agent_category as string | undefined);
      const a = ensure(
        id,
        actor.agent_name as string | undefined,
        innerPayload.task as string | undefined,
        engineCategory,
      );
      if (a.status === 'unknown') a.status = 'running';
    } else if (ev.event_type === 'agent.status.updated') {
      const id =
        (actor.agent_id as string | undefined) ??
        (innerPayload.agent_id as string | undefined);
      if (!id) continue;
      const a = ensure(id, actor.agent_name as string | undefined);
      const s = String(payload.status ?? '').toLowerCase();
      if (s === 'running') a.status = 'running';
      else if (TERMINAL_DONE.has(s)) a.status = 'completed';
      else if (TERMINAL_FAILED.has(s)) a.status = 'failed';
    } else if (ev.event_type === 'tool.execution.started') {
      const id = actor.agent_id as string | undefined;
      if (!id) continue;
      const a = ensure(id, actor.agent_name as string | undefined);
      const args = shapeAsObject(innerPayload.args);
      let surface: string | null = null;
      for (const k of ['url', 'endpoint', 'target', 'path']) {
        const v = args[k];
        if (typeof v === 'string' && v.trim()) {
          surface = v;
          break;
        }
      }
      a.toolCalls.push({
        tool_name:
          (actor.tool_name as string | undefined) ??
          (innerPayload.tool_name as string | undefined) ??
          'unknown',
        surface,
        ts: ev.created_at,
      });
    }
  }

  // Stable order: agents that ran first, by their first-seen tool call or
  // agent.created ordering. We just keep insertion order — Map iteration is
  // insertion-ordered in JS, and events arrive chronologically.
  return [...map.values()];
}

const STATUS_PILL: Record<AgentSummary['status'], { Icon: LucideIcon; cls: string; label: string }> = {
  running: {
    Icon: Activity,
    cls: 'bg-blue-500/15 text-blue-200 ring-blue-500/30',
    label: 'Running',
  },
  completed: {
    Icon: CheckCircle2,
    cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    label: 'Done',
  },
  failed: {
    Icon: XCircle,
    cls: 'bg-red-500/15 text-red-200 ring-red-500/30',
    label: 'Failed',
  },
  unknown: {
    Icon: Activity,
    cls: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    label: '—',
  },
};

// Strix's internal sub-agent names ("WorkerScanProcessorAgent") aren't
// meaningful to a reader — they're framework scaffolding, not security roles.
// Until Strix tags agents with a semantic role (see tools-wishlist.md §0),
// we just number them: "Investigator #1", #2, etc.
function friendlyName(agent: AgentSummary, ordinal: number): string {
  const isGenericName =
    agent.name === agent.id ||
    /^WorkerScanProcessor/i.test(agent.name) ||
    /^agent_[a-f0-9]+$/i.test(agent.name);
  if (isGenericName) return `Investigator #${ordinal}`;
  return agent.name;
}

// ---------------------------------------------------------------------------
// Agent specialisation heuristic — pillar 1 item 1.
//
// Strix doesn't tag sub-agents with a semantic category yet (see
// tools-wishlist.md §0 "Per-agent task category tag"). Until that lands,
// we infer the role from each agent's tool-call pattern. The signal is
// noisy — a single agent can dabble across categories — so we score every
// category, take the top, and only commit to a label if the lead is
// meaningful. Otherwise, fall back to no chip.
// ---------------------------------------------------------------------------

type AgentCategory =
  | 'recon'
  | 'auth'
  | 'injection'
  | 'ssrf'
  | 'web_app'
  | 'code_audit';

interface CategoryMeta {
  label: string;
  Icon: LucideIcon;
  cls: string;
}

const CATEGORY_META: Record<AgentCategory, CategoryMeta> = {
  recon:        { label: 'Recon',     Icon: Search,    cls: 'bg-cyan-500/10 text-cyan-200 ring-cyan-500/30' },
  auth:         { label: 'Auth',      Icon: KeyRound,  cls: 'bg-orange-500/10 text-orange-200 ring-orange-400/30' },
  injection:    { label: 'Injection', Icon: Bug,       cls: 'bg-rose-500/15 text-rose-200 ring-rose-400/30' },
  ssrf:         { label: 'SSRF',      Icon: Network,   cls: 'bg-violet-500/10 text-violet-200 ring-violet-500/30' },
  web_app:      { label: 'Web app',   Icon: Globe,     cls: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30' },
  code_audit:   { label: 'Code audit',Icon: FileCode,  cls: 'bg-amber-500/10 text-amber-200 ring-amber-400/30' },
};

const SQL_INJECTION_HINTS = ["'", '"', 'union', 'select', 'or 1=1', '-- ', '/*', 'sleep('];
const CMD_INJECTION_HINTS = ['; ls', '; cat', '|cat', '`whoami`', '$(', '&&', '||'];
const TEMPLATE_INJECTION_HINTS = ['{{', '${', '#{', '<%', '%>'];
const XSS_HINTS = ['<script', 'onerror=', 'onload=', 'javascript:', 'svg onload'];
const SSRF_HOST_HINTS = [
  '127.0.0.1', 'localhost', '0.0.0.0', '::1',
  '169.254.', '169.254.169.254',          // cloud metadata + link-local
  'metadata.google', 'metadata.azure',
  'internal.', '.internal',
  '.local', '.lan',
];
const AUTH_PATH_HINTS = ['/login', '/signin', '/signup', '/register', '/auth/', '/oauth/', '/sso/', '/saml/', '/.well-known/'];

// Map the engine's hyphenated role tags (PR #33) to our six-bucket
// AgentCategory. The engine emits a longer enum than ours; values we don't
// have a bucket for return null, and the chip renders the raw string.
const ENGINE_AGENT_CATEGORY_MAP: Record<string, AgentCategory> = {
  'webapp-recon': 'recon',
  'recon': 'recon',
  'subdomain-recon': 'recon',
  'dns-recon': 'recon',
  'auth-attacker': 'auth',
  'auth': 'auth',
  'sqli-validator': 'injection',
  'injection': 'injection',
  'xss-specialist': 'injection',
  'cmd-injection': 'injection',
  'ssrf-scanner': 'ssrf',
  'ssrf': 'ssrf',
  'webapp-attacker': 'web_app',
  'webapp': 'web_app',
  'code-audit': 'code_audit',
  'static-analysis': 'code_audit',
};

function mapEngineAgentCategory(raw: string): AgentCategory | null {
  return ENGINE_AGENT_CATEGORY_MAP[raw.toLowerCase()] ?? null;
}

function inferAgentCategory(agent: AgentSummary): AgentCategory | null {
  // Skip agents with too few signals — categorising 1–2 calls is mostly
  // noise. The "Investigator #N" fallback handles those gracefully.
  if (agent.toolCalls.length < 3) return null;

  const scores: Record<AgentCategory, number> = {
    recon: 0, auth: 0, injection: 0, ssrf: 0, web_app: 0, code_audit: 0,
  };

  for (const call of agent.toolCalls) {
    const tool = call.tool_name.toLowerCase();
    const surface = (call.surface ?? '').toLowerCase();

    // Code-audit signals — file/grep tools dominate.
    if (tool.startsWith('file_') || tool === 'file_grep' || tool === 'file_search') {
      scores.code_audit += 2;
      continue;
    }

    // Recon signals: terminal commands (likely nmap/dig/whatweb), well-known paths.
    if (tool === 'terminal_execute') {
      scores.recon += 1.5;
    }
    if (surface.includes('/.well-known/') || surface.includes('robots.txt') || surface.includes('sitemap')) {
      scores.recon += 1;
    }

    // Auth signals: login/signup/auth/oauth paths.
    for (const hint of AUTH_PATH_HINTS) {
      if (surface.includes(hint)) {
        scores.auth += 1;
        break;
      }
    }

    // SSRF signals: surface contains internal/metadata host hints.
    for (const hint of SSRF_HOST_HINTS) {
      if (surface.includes(hint)) {
        scores.ssrf += 2;
        break;
      }
    }

    // Injection signals: payload markers in the surface URL/path.
    let injHit = false;
    for (const hint of [...SQL_INJECTION_HINTS, ...CMD_INJECTION_HINTS, ...TEMPLATE_INJECTION_HINTS, ...XSS_HINTS]) {
      if (surface.includes(hint)) {
        scores.injection += 1.5;
        injHit = true;
        break;
      }
    }
    // URL-encoded forms of the same — common when payloads land in querystrings.
    if (!injHit && (surface.includes('%27') || surface.includes('%22') || surface.includes('%3cscript'))) {
      scores.injection += 1.5;
    }

    // Generic web-app signal: HTTP/browser tools without other category hits.
    if (tool === 'http_request' || tool.startsWith('browser_') || tool === 'proxy_inspect') {
      scores.web_app += 0.5;
    }
  }

  // Pick the category with the highest score, but only commit if it's
  // clearly above noise. Threshold: ≥ 3 absolute score AND ≥ 1.5x the
  // runner-up. Otherwise return null and the UI shows no chip.
  const sorted = (Object.entries(scores) as [AgentCategory, number][])
    .sort((a, b) => b[1] - a[1]);
  const [topCat, topScore] = sorted[0];
  const runnerUp = sorted[1]?.[1] ?? 0;
  if (topScore < 3) return null;
  if (runnerUp > 0 && topScore < runnerUp * 1.5) return null;
  return topCat;
}

export default function AgentsSection({
  events,
  expectedCount,
}: {
  events: ScanEvent[];
  expectedCount: number;
}) {
  const agents = useMemo(() => deriveAgents(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // If the scan didn't run any agents at all, hide the section entirely.
  if (agents.length === 0 && expectedCount === 0) return null;

  const total = expectedCount > 0 ? expectedCount : agents.length;
  const missing = Math.max(0, expectedCount - agents.length);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section id="agents" className="space-y-3 scroll-mt-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          AI investigators
        </h2>
        <span className="text-xs text-neutral-500">
          {total} agent{total === 1 ? '' : 's'} ran on this scan
        </span>
      </div>

      <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/20 p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-cyan-300/80" strokeWidth={2} />
          <p className="text-sm leading-relaxed text-neutral-300">
            Each <strong>investigator</strong> is an AI agent that probed your application
            independently. They can browse pages, hit APIs, read code, and chain attacks together
            — the same way a human security engineer would. The orchestrator splits the scan into
            focused threads and runs them in parallel, so the more investigators, the more
            simultaneous coverage.
          </p>
        </div>
      </div>

      {agents.length > 0 ? (
        <div className="space-y-2">
          {agents.map((agent, i) => {
            const ordinal = i + 1;
            const isOpen = expanded.has(agent.id);
            const pill = STATUS_PILL[agent.status];
            const PillIcon = pill.Icon;
            // Engine signal first (PR #33 deterministic role tag), heuristic
            // as fallback. Engine emits hyphenated lowercase strings like
            // `auth-attacker`; we map a few common ones to the same
            // CATEGORY_META that the heuristic uses, then fall back to
            // displaying the raw engine string when we don't have a mapping.
            const engineCategoryRaw = agent.engineCategory;
            const engineCategoryMapped = engineCategoryRaw
              ? mapEngineAgentCategory(engineCategoryRaw)
              : null;
            const category = engineCategoryMapped ?? inferAgentCategory(agent);
            const isFromEngine = engineCategoryRaw !== null;
            const categoryMeta = category ? CATEGORY_META[category] : null;
            // For engine strings we don't have a mapping for, render the raw
            // string with a generic chip styling so the user still sees the
            // role (e.g. `xss-specialist` even though we don't have a custom icon).
            const fallbackEngineLabel =
              !categoryMeta && engineCategoryRaw
                ? engineCategoryRaw.replace(/-/g, ' ')
                : null;
            const CategoryIcon = categoryMeta?.Icon;
            return (
              <div
                key={agent.id}
                className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30 transition-colors hover:border-neutral-700"
              >
                <button
                  type="button"
                  onClick={() => agent.toolCalls.length > 0 && toggle(agent.id)}
                  className={`flex w-full items-start gap-3 p-4 text-left ${
                    agent.toolCalls.length > 0 ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <ChevronRight
                    className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-neutral-500 transition-transform ${
                      agent.toolCalls.length === 0 ? 'invisible' : ''
                    } ${isOpen ? 'rotate-90 text-neutral-300' : ''}`}
                    strokeWidth={2.5}
                  />
                  <Bot
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-violet-300/80"
                    strokeWidth={2}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-100">
                        {friendlyName(agent, ordinal)}
                      </span>
                      {categoryMeta && CategoryIcon && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ring-1 ${categoryMeta.cls}`}
                          title={
                            isFromEngine
                              ? `Engine-emitted role tag: ${engineCategoryRaw}`
                              : "Inferred from this agent's tool-call pattern. Heuristic — not a strict label."
                          }
                        >
                          <CategoryIcon className="h-3 w-3" strokeWidth={2.5} />
                          {categoryMeta.label}
                        </span>
                      )}
                      {!categoryMeta && fallbackEngineLabel && (
                        <span
                          className="inline-flex items-center gap-1 rounded-md bg-neutral-800/80 px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-neutral-300 ring-1 ring-neutral-700/60"
                          title={`Engine role tag: ${engineCategoryRaw}`}
                        >
                          {fallbackEngineLabel}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${pill.cls}`}
                      >
                        <PillIcon className="h-3 w-3" strokeWidth={2.5} />
                        {pill.label}
                      </span>
                      {agent.toolCalls.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-500/20">
                          <Wrench className="h-3 w-3" strokeWidth={2.5} />
                          {agent.toolCalls.length} action
                          {agent.toolCalls.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    {agent.task ? (
                      <p className="text-[13px] leading-relaxed text-neutral-300">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
                          Brief
                        </span>{' '}
                        {agent.task}
                      </p>
                    ) : (
                      <p className="text-[12px] italic leading-relaxed text-neutral-500">
                        No specific brief recorded — this investigator inherited the parent scan's
                        instructions.
                      </p>
                    )}
                  </div>
                </button>
                {isOpen && agent.toolCalls.length > 0 && (
                  <div className="border-t border-neutral-800/60 bg-neutral-950/40 px-4 py-3">
                    <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
                      What this investigator did
                    </div>
                    <ol className="space-y-1.5">
                      {agent.toolCalls.map((c, i) => (
                        <li
                          key={`${c.ts}-${i}`}
                          className="flex items-baseline gap-2 font-mono text-[11.5px]"
                        >
                          <span className="w-6 flex-shrink-0 text-right text-neutral-600">
                            {i + 1}.
                          </span>
                          <span className="text-amber-300/90">
                            {plainLanguageTool(c.tool_name)}
                          </span>
                          {c.surface && (
                            <span className="min-w-0 flex-1 truncate text-neutral-400">
                              {c.surface}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            );
          })}
          {missing > 0 && (
            <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/10 px-4 py-3 text-[12.5px] text-neutral-500">
              + {missing} more investigator{missing === 1 ? '' : 's'} ran but per-agent details
              weren't captured (older scans missed the live event stream).
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 p-5 text-sm text-neutral-400">
          This scan ran <strong>{expectedCount}</strong> investigator
          {expectedCount === 1 ? '' : 's'}, but per-agent details weren't captured. Future scans
          will list each one with its specific brief and the actions it took.
        </div>
      )}
    </section>
  );
}

// Translate Strix's tool names into something a non-Strix-developer would
// recognise. Tools we don't have a translation for fall back to the raw name.
const TOOL_LABELS: Record<string, string> = {
  agent_finish: 'Wrap up & report',
  browser_navigate: 'Browsed a page',
  browser_click: 'Clicked a button',
  browser_fill: 'Filled out a form',
  browser_screenshot: 'Took a screenshot',
  browser_javascript: 'Ran JavaScript in the page',
  http_request: 'Sent an HTTP request',
  terminal_execute: 'Ran a shell command',
  file_read: 'Read a file',
  file_write: 'Wrote to a file',
  file_edit: 'Edited a file',
  file_search: 'Searched the codebase',
  file_grep: 'Searched the codebase',
  proxy_inspect: 'Inspected captured traffic',
  proxy_replay: 'Replayed an HTTP request',
  notes_write: 'Wrote a note',
  notes_read: 'Read a note',
  create_subagent: 'Spawned another investigator',
  create_vulnerability_report: 'Filed a vulnerability report',
  scan_start_info: 'Started the scan',
  subagent_start_info: 'Started a sub-agent',
};

function plainLanguageTool(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
