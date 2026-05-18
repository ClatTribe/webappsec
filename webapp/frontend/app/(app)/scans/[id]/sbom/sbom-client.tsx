'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Package,
  Download,
  Search,
  Loader2,
  AlertCircle,
  ArrowUpDown,
  ShieldAlert,
} from 'lucide-react';
import type {
  CycloneDxBom,
  CycloneDxComponent,
  CycloneDxVulnerability,
} from '@/lib/supabase/types';

// SbomClient — interactive CycloneDX 1.5 viewer.
//
// One-time fetch of the parsed SBOM via `/api/scans/[id]/sbom`. All
// filter / sort / search interactions are client-side because the
// component list is bounded (a couple of hundred entries at most)
// and CycloneDX 1.5 fits comfortably in browser memory.
//
// Layout (wishlist §14.6 row 1 + row 3):
//   • Header strip — total component count, SBOM tool/version, link
//     to download the raw CycloneDX file
//   • Toolbar — search box (name/purl), type filter chips
//   • Table — name, version, type, license, scope, detected_via,
//     vulnerable badge. Each header is a sort toggle.
//   • Vulnerabilities footer — when CycloneDX `vulnerabilities[]`
//     is non-empty, we surface the count + a per-component badge in
//     the table row

interface Props {
  scanId: string;
  runName: string;
}

type SortKey = 'name' | 'version' | 'type' | 'scope' | 'license' | 'detected_via';

export default function SbomClient({ scanId, runName }: Props) {
  const [bom, setBom] = useState<CycloneDxBom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}/sbom`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) {
            setError(body.error ?? `failed (${res.status})`);
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as CycloneDxBom;
        if (!cancelled) {
          setBom(data);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'request failed');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const components = useMemo<CycloneDxComponent[]>(
    () => (Array.isArray(bom?.components) ? (bom!.components as CycloneDxComponent[]) : []),
    [bom],
  );

  // Vulnerable component bom-refs — used to badge each row in the
  // table. CycloneDX `vulnerabilities[].affects[]` carry `ref` fields
  // pointing at component bom-refs.
  const vulnerableRefs = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    const vulns = (Array.isArray(bom?.vulnerabilities) ? bom!.vulnerabilities : []) as CycloneDxVulnerability[];
    for (const v of vulns) {
      if (!Array.isArray(v.affects)) continue;
      for (const a of v.affects) {
        if (typeof a.ref === 'string' && a.ref) s.add(a.ref);
      }
    }
    return s;
  }, [bom]);

  const distinctTypes = useMemo<string[]>(
    () => Array.from(new Set(components.map((c) => c.type ?? 'unknown'))).sort(),
    [components],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = components;
    if (typeFilter) rows = rows.filter((c) => (c.type ?? 'unknown') === typeFilter);
    if (q) {
      rows = rows.filter((c) => {
        const haystack = [c.name, c.group, c.purl, c.description, c.version]
          .filter((v) => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => dir * compareBy(a, b, sortKey));
  }, [components, search, typeFilter, sortKey, sortDir]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 text-sm text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin text-neutral-500" strokeWidth={2.5} />
        Loading component list…
      </section>
    );
  }

  if (error || !bom) {
    return (
      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.05] p-6">
        <div className="flex items-start gap-3 text-sm text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={2.5} />
          <div className="space-y-1">
            <div className="font-medium">Could not load component list</div>
            <div className="text-rose-200/70">{error ?? 'no body'}</div>
          </div>
        </div>
      </section>
    );
  }

  const tool = describeBomTool(bom);

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-neutral-900/70 ring-1 ring-inset ring-white/5">
            <Package className="h-5 w-5 text-cyan-300" strokeWidth={2} />
          </div>
          <div className="space-y-0.5">
            <h1 className="text-lg font-semibold text-neutral-100">{runName} — Component list</h1>
            <p className="text-[12px] text-neutral-500">
              CycloneDX {bom.specVersion ?? '1.5'} · {components.length} component
              {components.length === 1 ? '' : 's'}
              {tool && <> · generated by {tool}</>}
              {vulnerableRefs.size > 0 && (
                <>
                  {' '}·{' '}
                  <span className="text-amber-300">{vulnerableRefs.size} vulnerable</span>
                </>
              )}
            </p>
          </div>
        </div>
        <a
          href={`/api/scans/${scanId}/sbom?format=cyclonedx`}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:border-violet-500/50 hover:bg-violet-500/20"
          title="Download the raw CycloneDX 1.5 JSON for handoff to compliance / SCA tooling"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} />
          Download CycloneDX
        </a>
      </section>

      <section className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
        <div className="flex flex-wrap items-center gap-3 pb-4">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" strokeWidth={2.25} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name, group, version, or purl…"
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 font-mono text-xs text-neutral-100 placeholder-neutral-600 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {distinctTypes.map((t) => {
              const active = typeFilter === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter(active ? null : t)}
                  className={`rounded-md px-2 py-1 text-[10.5px] font-medium ring-1 transition-colors ${
                    active
                      ? 'bg-cyan-500/15 text-cyan-200 ring-cyan-400/30'
                      : 'bg-neutral-900/40 text-neutral-300 ring-neutral-800 hover:bg-neutral-800/40'
                  }`}
                >
                  {t}
                </button>
              );
            })}
            {(typeFilter || search) && (
              <button
                type="button"
                onClick={() => {
                  setTypeFilter(null);
                  setSearch('');
                }}
                className="rounded-md bg-neutral-900/40 px-2 py-1 text-[10.5px] font-medium text-neutral-400 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800/40"
              >
                clear
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-800 bg-neutral-950/30 px-3 py-4 text-center text-[11.5px] text-neutral-500">
            No components match the current filter.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800/80">
            <table className="w-full text-[11.5px]">
              <thead className="bg-neutral-950/40 text-left text-[10px] uppercase tracking-wider text-neutral-500">
                <tr>
                  <SortHeader
                    label="Name"
                    keyName="name"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <SortHeader
                    label="Version"
                    keyName="version"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <SortHeader
                    label="Type"
                    keyName="type"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <SortHeader
                    label="License"
                    keyName="license"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <SortHeader
                    label="Scope"
                    keyName="scope"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <SortHeader
                    label="Detected via"
                    keyName="detected_via"
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={(k) => toggleSort(k, sortKey, sortDir, setSortKey, setSortDir)}
                  />
                  <th className="px-3 py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/60">
                {filtered.map((c, i) => {
                  const ref = c['bom-ref'];
                  const isVuln = typeof ref === 'string' && vulnerableRefs.has(ref);
                  return (
                    <tr
                      key={ref ?? `row-${i}`}
                      className="font-mono transition-colors hover:bg-neutral-900/40"
                    >
                      <td className="px-3 py-2 text-neutral-200">
                        <div className="flex flex-col">
                          <span className="font-semibold">{c.name ?? '—'}</span>
                          {c.purl && (
                            <span className="truncate text-[10px] text-neutral-500" title={c.purl}>
                              {c.purl}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-neutral-300">{c.version ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{c.type ?? 'unknown'}</td>
                      <td className="px-3 py-2 text-neutral-400">{licenseText(c) ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-500">{c.scope ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-500">{c.detected_via ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {isVuln ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30"
                            title="CycloneDX vulnerabilities[] entry references this component"
                          >
                            <ShieldAlert className="h-3 w-3" strokeWidth={2.5} />
                            vuln
                          </span>
                        ) : (
                          <span className="text-[10px] text-neutral-700">·</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="pt-3 text-[10.5px] text-neutral-500">
          Showing {filtered.length} of {components.length} components. Click any header to sort.
        </p>
      </section>
    </div>
  );
}

function compareBy(a: CycloneDxComponent, b: CycloneDxComponent, key: SortKey): number {
  const get = (c: CycloneDxComponent): string => {
    if (key === 'license') return licenseText(c) ?? '';
    return ((c as Record<string, unknown>)[key] as string | undefined) ?? '';
  };
  const av = get(a).toString().toLowerCase();
  const bv = get(b).toString().toLowerCase();
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function toggleSort(
  k: SortKey,
  current: SortKey,
  dir: 'asc' | 'desc',
  setKey: (k: SortKey) => void,
  setDir: (d: 'asc' | 'desc') => void,
) {
  if (k === current) {
    setDir(dir === 'asc' ? 'desc' : 'asc');
  } else {
    setKey(k);
    setDir('asc');
  }
}

function licenseText(c: CycloneDxComponent): string | null {
  if (!Array.isArray(c.licenses) || c.licenses.length === 0) return null;
  const first = c.licenses[0]?.license;
  if (!first) return null;
  return first.id ?? first.name ?? null;
}

function describeBomTool(bom: CycloneDxBom): string | null {
  const tools = bom.metadata?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const t = tools[0];
    if (t.name) return [t.vendor, t.name, t.version].filter(Boolean).join(' ');
  }
  if (
    tools
    && typeof tools === 'object'
    && 'components' in tools
    && Array.isArray((tools as { components?: unknown[] }).components)
  ) {
    const first = (tools as { components: Array<Record<string, unknown>> }).components[0];
    if (first?.name) {
      return [first.vendor, first.name, first.version]
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
    }
  }
  return null;
}

function SortHeader({
  label,
  keyName,
  activeKey,
  dir,
  onClick,
}: {
  label: string;
  keyName: SortKey;
  activeKey: SortKey;
  dir: 'asc' | 'desc';
  onClick: (k: SortKey) => void;
}) {
  const active = activeKey === keyName;
  return (
    <th
      className={`cursor-pointer select-none px-3 py-2 transition-colors ${
        active ? 'text-cyan-300' : 'hover:text-neutral-300'
      }`}
      onClick={() => onClick(keyName)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown
          className={`h-3 w-3 ${active ? 'opacity-100' : 'opacity-30'} ${
            active && dir === 'desc' ? 'rotate-180' : ''
          }`}
          strokeWidth={2.5}
        />
      </span>
    </th>
  );
}
