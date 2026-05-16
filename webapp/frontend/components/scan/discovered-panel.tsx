'use client';

import { useMemo, useState } from 'react';
import {
  Layers,
  Server,
  KeyRound,
  Lock,
  Package,
  Radar,
  Zap,
  ShieldQuestion,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// DiscoveredPanel — engine PRs #240 + #265 + #266 (typed knowledge graph) /
// migration 058.
//
// Renders the per-scan KG as a tabbed surface inventory. Each tab is one
// of the engine's node kinds; node `props` are open-schema so we render
// the well-known fields per tab and stash the rest into a "Details" pop-out.
//
// Source of truth: rows from `kg_nodes` for this scan. Drift-resilient by
// design — a new node kind the wrapper doesn't yet template lands in
// the `Other` tab as a generic key→value list.

type NodeKind =
  | 'Surface'
  | 'Asset'
  | 'Credential'
  | 'Secret'
  | 'Dependency'
  | 'ThreatIntel'
  | 'Exploit';

export interface KgNode {
  id: string;
  scan_id: string;
  node_id: string;
  node_type: string;
  props: Record<string, unknown> | null;
  created_at: string;
}

interface Props {
  nodes: KgNode[];
}

const TAB_META: Record<NodeKind, { Icon: LucideIcon; label: string; tone: string; description: string }> = {
  Surface: {
    Icon: Radar,
    label: 'Surfaces',
    tone: 'cyan',
    description: 'HTTP endpoints, API routes, hosts the agent reached.',
  },
  Asset: {
    Icon: Server,
    label: 'Assets',
    tone: 'blue',
    description: 'Hosts, IPs, services the agent inventoried.',
  },
  Credential: {
    Icon: KeyRound,
    label: 'Credentials',
    tone: 'amber',
    description: 'Working credentials the agent discovered or captured.',
  },
  Secret: {
    Icon: Lock,
    label: 'Secrets',
    tone: 'red',
    description: 'API keys, tokens, private keys leaked in scope.',
  },
  Dependency: {
    Icon: Package,
    label: 'Dependencies',
    tone: 'violet',
    description: 'Third-party packages observed in the target.',
  },
  ThreatIntel: {
    Icon: ShieldQuestion,
    label: 'Threat intel',
    tone: 'emerald',
    description: 'External observations from VT / KEV / OTX / etc.',
  },
  Exploit: {
    Icon: Zap,
    label: 'Exploits',
    tone: 'rose',
    description: 'Synthesised working exploits with captured proof of impact.',
  },
};

const TAB_ORDER: NodeKind[] = [
  'Asset',
  'Surface',
  'Secret',
  'Credential',
  'Dependency',
  'ThreatIntel',
  'Exploit',
];

const TONE_RING: Record<string, string> = {
  cyan: 'ring-cyan-400/30 text-cyan-200 bg-cyan-500/10',
  blue: 'ring-blue-400/30 text-blue-200 bg-blue-500/10',
  amber: 'ring-amber-400/30 text-amber-200 bg-amber-500/10',
  red: 'ring-red-400/30 text-red-200 bg-red-500/10',
  violet: 'ring-violet-400/30 text-violet-200 bg-violet-500/10',
  emerald: 'ring-emerald-400/30 text-emerald-200 bg-emerald-500/10',
  rose: 'ring-rose-400/30 text-rose-200 bg-rose-500/10',
  zinc: 'ring-zinc-600/40 text-zinc-300 bg-zinc-700/30',
};

function isKnownKind(t: string): t is NodeKind {
  return (TAB_ORDER as string[]).includes(t);
}

export default function DiscoveredPanel({ nodes }: Props) {
  // Skip Vuln + Role from the panel — Vuln duplicates the findings inbox,
  // Role is engine-internal authorization metadata that doesn't render
  // usefully in this surface. Everything else is tab-eligible.
  const filtered = useMemo(
    () => nodes.filter((n) => n.node_type !== 'Vuln' && n.node_type !== 'Role'),
    [nodes],
  );

  // Group by node_type so each tab has a count badge + can render quickly.
  const byKind = useMemo(() => {
    const m = new Map<string, KgNode[]>();
    for (const n of filtered) {
      const arr = m.get(n.node_type);
      if (arr) arr.push(n);
      else m.set(n.node_type, [n]);
    }
    return m;
  }, [filtered]);

  // Order tabs by canonical order, then any unknown kinds the wrapper
  // doesn't yet template (engine drift) at the end.
  const tabs = useMemo(() => {
    const known: { kind: string; count: number }[] = [];
    const seen = new Set<string>();
    for (const k of TAB_ORDER) {
      if (byKind.has(k)) {
        known.push({ kind: k, count: byKind.get(k)!.length });
        seen.add(k);
      }
    }
    for (const k of byKind.keys()) {
      if (!seen.has(k)) known.push({ kind: k, count: byKind.get(k)!.length });
    }
    return known;
  }, [byKind]);

  const [active, setActive] = useState<string | null>(
    tabs.length > 0 ? tabs[0].kind : null,
  );

  if (filtered.length === 0) return null;

  const activeNodes = active ? byKind.get(active) ?? [] : [];
  const meta = active && isKnownKind(active) ? TAB_META[active] : null;

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-neutral-400" strokeWidth={2.25} />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            Discovered
          </h2>
        </div>
        <span
          className="text-[10.5px] text-neutral-500"
          title="Typed knowledge graph the engine built during this scan (strix PRs #240/#265/#266). Source: kg.json artefact."
        >
          {filtered.length} item{filtered.length === 1 ? '' : 's'} across {tabs.length} kind
          {tabs.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Tab row */}
      <nav className="flex flex-wrap items-center gap-1.5">
        {tabs.map((t) => {
          const tm = isKnownKind(t.kind) ? TAB_META[t.kind] : null;
          const Icon = tm?.Icon ?? Layers;
          const isActive = active === t.kind;
          const tone = tm?.tone ?? 'zinc';
          return (
            <button
              key={t.kind}
              type="button"
              onClick={() => setActive(t.kind)}
              className={`group inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium ring-1 transition-colors ${
                isActive
                  ? TONE_RING[tone]
                  : 'bg-neutral-900/40 text-neutral-400 ring-neutral-800 hover:text-neutral-100 hover:ring-neutral-700'
              }`}
            >
              <Icon className="h-3 w-3" strokeWidth={2.25} />
              <span>{tm?.label ?? t.kind}</span>
              <span
                className={`rounded-full px-1.5 text-[10.5px] font-mono ${
                  isActive ? 'bg-neutral-950/50' : 'bg-neutral-800/60 text-neutral-500'
                }`}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </nav>

      {meta && (
        <p className="text-[11px] leading-relaxed text-neutral-500">{meta.description}</p>
      )}

      {/* Item list */}
      <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40">
        {activeNodes.slice(0, 50).map((n) => (
          <NodeRow key={n.id} node={n} />
        ))}
      </ul>
      {activeNodes.length > 50 && (
        <p className="text-[10.5px] text-neutral-500">
          Showing 50 of {activeNodes.length} — the rest live in <span className="font-mono text-neutral-400">kg_nodes</span>.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-node rendering
// ---------------------------------------------------------------------------

function NodeRow({ node }: { node: KgNode }) {
  const [expanded, setExpanded] = useState(false);
  const { headline, sub } = headlinerFor(node);
  const props = node.props ?? {};
  const extraKeys = Object.keys(props).filter((k) => !HEADLINE_KEYS.has(k));

  return (
    <li className="px-3 py-2 hover:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
      >
        <ChevronRight
          className={`mt-0.5 h-3 w-3 flex-shrink-0 text-neutral-600 transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
          strokeWidth={2.5}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-neutral-200">{headline}</div>
          {sub && (
            <div className="mt-0.5 truncate text-[10.5px] text-neutral-500">{sub}</div>
          )}
        </div>
        <span className="flex-shrink-0 font-mono text-[10px] text-neutral-600">
          {node.node_id}
        </span>
      </button>
      {expanded && extraKeys.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-neutral-800/50 pl-5 pt-2 text-[10.5px] sm:grid-cols-2">
          {extraKeys.slice(0, 12).map((k) => (
            <div key={k} className="flex flex-wrap gap-1">
              <dt className="font-medium uppercase tracking-wide text-neutral-500">{k}</dt>
              <dd className="min-w-0 break-all text-neutral-300">{renderValue(props[k])}</dd>
            </div>
          ))}
          {extraKeys.length > 12 && (
            <span className="text-neutral-600">+{extraKeys.length - 12} more</span>
          )}
        </dl>
      )}
    </li>
  );
}

// Per-node-kind headline + subtitle templating. Falls through to a
// generic id+type pair so an engine-added kind still renders something
// readable.
const HEADLINE_KEYS = new Set([
  // shared across most kinds
  'target', 'host', 'url', 'name', 'value', 'identifier', 'path',
  // surfaces
  'method', 'endpoint',
  // secrets / credentials
  'kind', 'secret_kind', 'username', 'principal',
  // dependencies
  'package', 'package_name', 'version', 'ecosystem',
  // threat intel
  'source', 'verdict',
  // exploits
  'cve', 'judge_score',
]);

function headlinerFor(n: KgNode): { headline: string; sub: string | null } {
  const p = n.props ?? {};
  const s = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  switch (n.node_type) {
    case 'Surface': {
      const url = s(p.url) ?? s(p.endpoint) ?? s(p.target);
      const method = s(p.method);
      return {
        headline: method && url ? `${method.toUpperCase()} ${url}` : url ?? n.node_id,
        sub: s(p.kind),
      };
    }
    case 'Asset': {
      const headline = s(p.host) ?? s(p.target) ?? s(p.url) ?? s(p.name) ?? n.node_id;
      const ip = s(p.ip) ?? s(p.address);
      return { headline, sub: ip };
    }
    case 'Secret': {
      const kind = s(p.secret_kind) ?? s(p.kind) ?? 'secret';
      const ident = s(p.identifier) ?? s(p.name) ?? s(p.path);
      return { headline: ident ?? n.node_id, sub: `${kind}` };
    }
    case 'Credential': {
      const user = s(p.username) ?? s(p.principal);
      const target = s(p.target) ?? s(p.host);
      return {
        headline: user && target ? `${user} @ ${target}` : user ?? target ?? n.node_id,
        sub: s(p.kind),
      };
    }
    case 'Dependency': {
      const pkg = s(p.package_name) ?? s(p.package) ?? s(p.name) ?? n.node_id;
      const version = s(p.version);
      const eco = s(p.ecosystem);
      const sub = [eco, version].filter(Boolean).join(' · ');
      return { headline: pkg, sub: sub || null };
    }
    case 'ThreatIntel': {
      const source = s(p.source) ?? 'observation';
      const target = s(p.target) ?? s(p.host) ?? s(p.identifier);
      const verdict = s(p.verdict);
      return {
        headline: target ?? n.node_id,
        sub: verdict ? `${source} · ${verdict}` : source,
      };
    }
    case 'Exploit': {
      const cve = s(p.cve);
      const score = p.judge_score;
      const headline = cve ?? n.node_id;
      const sub =
        typeof score === 'number'
          ? `judge ${score.toFixed(2)}`
          : s(p.exploit_script_path);
      return { headline, sub };
    }
    default: {
      const headline =
        s(p.name) ??
        s(p.identifier) ??
        s(p.target) ??
        s(p.value) ??
        n.node_id;
      return { headline, sub: n.node_type };
    }
  }
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
