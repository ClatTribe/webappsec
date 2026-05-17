'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Cloud,
  Server,
  Key,
  FileText,
  Globe,
  Database,
  Network,
  Lock,
  ChevronRight,
  ChevronDown,
  AlertOctagon,
  Loader2,
  Search,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { CloudInventoryNode, CloudInventoryNeighbour } from '@/lib/supabase/types';

// Cloud Asset Inventory — wrapper-side surface for the engine's typed
// cloud knowledge graph (engine PRs #290/#291/#293).
//
// The single highest-leverage move toward narrowing the Wiz gap on
// cloud_account scans. We already store CloudResource / CloudIdentity
// / CloudPolicy nodes + the edges that connect them in kg_nodes /
// kg_edges. This component is the inventory + relationship browser
// that makes them visible:
//
//   - Per-service rollup (S3 / EC2 / IAM / RDS / VPC / KMS / Lambda)
//   - Per-row exposure + finding + attack-path counts
//   - Expandable drill-in showing incoming + outgoing edges
//
// Visual graph (force-directed layout) is a follow-up; tabular
// inventory + edge browser already closes the "what does TS know
// about my cloud account?" question for the auditor.
//
// Hidden when the scan has no cloud nodes — non-cloud scans render
// unchanged.

interface Props {
  scanId: string;
}

// Service → icon mapping. Falls back to Cloud for anything we don't
// recognise so a new service shows up looking sensible without a code
// change.
function serviceIcon(service: string): typeof Cloud {
  const s = service.toLowerCase();
  if (s === 's3' || s === 'storage' || s === 'gcs' || s === 'blob') return Database;
  if (s === 'ec2' || s === 'compute' || s === 'gce' || s === 'vm') return Server;
  if (s === 'iam' || s === 'identity' || s === 'rbac') return Key;
  if (s === 'rds' || s === 'sql' || s === 'cloudsql' || s === 'dynamodb' || s === 'aurora')
    return Database;
  if (s === 'vpc' || s === 'network' || s === 'vnet' || s === 'sg') return Network;
  if (s === 'kms' || s === 'secretsmanager' || s === 'keyring') return Lock;
  if (s === 'lambda' || s === 'function' || s === 'cloudrun') return FileText;
  if (s === 'cloudtrail' || s === 'audit') return FileText;
  if (s === 'route53' || s === 'dns') return Globe;
  return Cloud;
}

function nodeTypeBadge(type: CloudInventoryNode['node_type']): { label: string; cls: string } {
  switch (type) {
    case 'CloudResource':
      return { label: 'Resource', cls: 'bg-cyan-500/15 text-cyan-200 ring-cyan-400/30' };
    case 'CloudIdentity':
      return { label: 'Identity', cls: 'bg-amber-500/15 text-amber-200 ring-amber-400/30' };
    case 'CloudPolicy':
      return { label: 'Policy', cls: 'bg-violet-500/15 text-violet-200 ring-violet-400/30' };
    case 'CloudFlow':
      return { label: 'Flow', cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30' };
    case 'ExternalPrincipal':
      return { label: 'External', cls: 'bg-rose-500/15 text-rose-200 ring-rose-400/30' };
  }
}

export default function CloudAssetInventory({ scanId }: Props) {
  const supabase = createClient();
  const [nodes, setNodes] = useState<CloudInventoryNode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('kg_cloud_inventory', {
        p_scan_id: scanId,
      });
      if (cancelled) return;
      if (error) {
        setErr(error.message);
        setNodes([]);
        return;
      }
      setNodes((data ?? []) as CloudInventoryNode[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId, supabase]);

  // Grouped by service for the service-rollup header.
  const byService = useMemo(() => {
    if (!nodes) return new Map<string, CloudInventoryNode[]>();
    const m = new Map<string, CloudInventoryNode[]>();
    const filt = query
      ? nodes.filter((n) => {
          const q = query.toLowerCase();
          return (
            n.display_name.toLowerCase().includes(q) ||
            n.service.toLowerCase().includes(q) ||
            n.node_id.toLowerCase().includes(q)
          );
        })
      : nodes;
    for (const n of filt) {
      const arr = m.get(n.service);
      if (arr) arr.push(n);
      else m.set(n.service, [n]);
    }
    return m;
  }, [nodes, query]);

  // Hide entirely when there are no cloud nodes (non-cloud scan).
  if (nodes !== null && nodes.length === 0 && !err) return null;

  const totalNodes = nodes?.length ?? 0;
  const exposedCount = nodes?.filter((n) => n.exposed_to_internet).length ?? 0;
  const pathParticipants = nodes?.filter((n) => n.attack_path_count > 0).length ?? 0;

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Cloud className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-300">
            Cloud asset inventory
          </h2>
          {nodes !== null && (
            <span className="text-[10.5px] text-neutral-500">
              {totalNodes} nodes · {byService.size} services
            </span>
          )}
        </div>
        {nodes !== null && (
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            {exposedCount > 0 && (
              <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-200 ring-1 ring-rose-400/30">
                {exposedCount} exposed
              </span>
            )}
            {pathParticipants > 0 && (
              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-200 ring-1 ring-amber-400/30">
                {pathParticipants} on attack paths
              </span>
            )}
          </div>
        )}
      </header>

      {nodes === null ? (
        <div className="py-3 text-[11.5px] text-neutral-500">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} />
          Loading cloud asset graph…
        </div>
      ) : err ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {err}
        </div>
      ) : (
        <>
          {/* Filter ------------------------------------------------- */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500"
              strokeWidth={2.5}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name, ARN, or service…"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950/60 py-1.5 pl-7 pr-3 text-[11.5px] text-neutral-100 placeholder:text-neutral-600 focus:border-cyan-500/40 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>

          {/* Service groups --------------------------------------- */}
          <ul className="space-y-3">
            {[...byService.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([service, list]) => (
                <ServiceGroup
                  key={service}
                  service={service}
                  nodes={list}
                  expanded={expanded}
                  onExpand={(id) => setExpanded((cur) => (cur === id ? null : id))}
                  scanId={scanId}
                />
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

// =============== Service group ===================================

function ServiceGroup({
  service,
  nodes,
  expanded,
  onExpand,
  scanId,
}: {
  service: string;
  nodes: CloudInventoryNode[];
  expanded: string | null;
  onExpand: (id: string) => void;
  scanId: string;
}) {
  const Icon = serviceIcon(service);
  const exposed = nodes.filter((n) => n.exposed_to_internet).length;
  const onPaths = nodes.filter((n) => n.attack_path_count > 0).length;

  return (
    <li>
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-400">
        <Icon className="h-3 w-3 text-cyan-300/70" strokeWidth={2.5} />
        <span className="font-semibold">{service}</span>
        <span className="font-mono text-neutral-500">{nodes.length}</span>
        {exposed > 0 && (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-200">
            {exposed} exposed
          </span>
        )}
        {onPaths > 0 && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-200">
            {onPaths} on path
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {nodes.map((n) => (
          <NodeRow
            key={n.node_id}
            node={n}
            expanded={expanded === n.node_id}
            onToggle={() => onExpand(n.node_id)}
            scanId={scanId}
          />
        ))}
      </ul>
    </li>
  );
}

// =============== Node row ========================================

function NodeRow({
  node,
  expanded,
  onToggle,
  scanId,
}: {
  node: CloudInventoryNode;
  expanded: boolean;
  onToggle: () => void;
  scanId: string;
}) {
  const badge = nodeTypeBadge(node.node_type);
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800/60 bg-neutral-950/30">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-900/50"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-neutral-400" strokeWidth={2.5} />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-neutral-500" strokeWidth={2.5} />
        )}
        <span
          className={`flex-shrink-0 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${badge.cls}`}
        >
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200">
          {node.display_name}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[10px]">
          {node.exposed_to_internet && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-rose-500/15 px-1 py-px font-medium text-rose-200"
              title="Reachable from the internet"
            >
              <Globe className="h-2.5 w-2.5" strokeWidth={2.5} />
              public
            </span>
          )}
          {node.attack_path_count > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px font-medium text-amber-200"
              title={`Participates in ${node.attack_path_count} attack path${node.attack_path_count === 1 ? '' : 's'}`}
            >
              <AlertOctagon className="h-2.5 w-2.5" strokeWidth={2.5} />
              {node.attack_path_count}
            </span>
          )}
          {node.finding_count > 0 && (
            <span className="text-neutral-500" title="Findings referencing this node">
              {node.finding_count} finding{node.finding_count === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>
      {expanded && <NodeEdges scanId={scanId} nodeId={node.node_id} />}
    </li>
  );
}

// =============== Edges drill-in ==================================

function NodeEdges({ scanId, nodeId }: { scanId: string; nodeId: string }) {
  const supabase = createClient();
  const [edges, setEdges] = useState<CloudInventoryNeighbour[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('kg_cloud_neighbours', {
        p_scan_id: scanId,
        p_node_id: nodeId,
      });
      if (cancelled) return;
      setEdges((data ?? []) as CloudInventoryNeighbour[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId, nodeId, supabase]);

  if (edges === null) {
    return (
      <div className="border-t border-neutral-800/60 bg-neutral-950/40 px-3 py-2 text-[10.5px] text-neutral-500">
        <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} /> Loading edges…
      </div>
    );
  }
  if (edges.length === 0) {
    return (
      <div className="border-t border-neutral-800/60 bg-neutral-950/40 px-3 py-2 text-[10.5px] italic text-neutral-500">
        No edges recorded for this node.
      </div>
    );
  }
  const out = edges.filter((e) => e.direction === 'out');
  const inc = edges.filter((e) => e.direction === 'in');
  return (
    <div className="space-y-2 border-t border-neutral-800/60 bg-neutral-950/40 px-3 py-2.5 text-[11px]">
      {out.length > 0 && <EdgeList title="Out →" edges={out} />}
      {inc.length > 0 && <EdgeList title="In ←" edges={inc} />}
    </div>
  );
}

function EdgeList({ title, edges }: { title: string; edges: CloudInventoryNeighbour[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </div>
      <ul className="space-y-0.5">
        {edges.map((e, i) => (
          <li
            key={`${e.edge_type}-${e.other_node_id}-${i}`}
            className="flex items-center gap-1.5 font-mono text-[10.5px]"
          >
            <span className="rounded bg-cyan-500/10 px-1 py-px text-[9.5px] font-semibold uppercase text-cyan-200/90 ring-1 ring-cyan-400/20">
              {e.edge_type}
            </span>
            <span className="truncate text-neutral-300" title={e.other_node_id}>
              {e.other_display_name ?? e.other_node_id}
            </span>
            {e.other_node_type && (
              <span className="text-[9.5px] text-neutral-600">({e.other_node_type})</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
