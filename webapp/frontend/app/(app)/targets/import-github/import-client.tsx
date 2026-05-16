'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  Search,
  Lock,
  GitFork,
  Check,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';

interface Integration {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
}

interface Repo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  pushed_at: string | null;
  default_branch: string | null;
  already_imported: boolean;
}

// Phase B #3 — bulk repo importer. Fetches /api/integrations/<id>/repos
// once when an integration is picked, then renders a searchable list
// with per-row checkboxes. The "Import" CTA fires N parallel POSTs
// to /api/targets (one per selected repo), with a progress counter
// so the user can see the import roll through.
export default function ImportClient({ integrations }: { integrations: Integration[] }) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string>(integrations[0]?.id ?? '');
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importInFlight, setImportInFlight] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setRepos(null);
    setSelected(new Set());
    (async () => {
      try {
        const res = await fetch(`/api/integrations/${activeId}/repos`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (cancelled) return;
          setLoadError(body.error ?? `Failed to load repos (HTTP ${res.status}).`);
          return;
        }
        const data = (await res.json()) as { repos: Repo[] };
        if (cancelled) return;
        setRepos(data.repos);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    if (!query.trim()) return repos;
    const q = query.trim().toLowerCase();
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q),
    );
  }, [repos, query]);

  function toggleRepo(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function selectAllFiltered() {
    const importable = filtered.filter((r) => !r.already_imported).map((r) => r.id);
    const allPicked =
      importable.length > 0 && importable.every((id) => selected.has(id));
    if (allPicked) {
      const next = new Set(selected);
      for (const id of importable) next.delete(id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const id of importable) next.add(id);
      setSelected(next);
    }
  }

  async function importPicked() {
    if (importInFlight || !repos || selected.size === 0) return;
    setImportInFlight(true);
    setImportedCount(0);
    setImportErrors([]);
    const targets = repos.filter((r) => selected.has(r.id) && !r.already_imported);
    const errors: string[] = [];
    let done = 0;
    // POST sequentially (rather than parallel) so a transient failure
    // doesn't cascade and so the user sees the counter advance.
    for (const r of targets) {
      try {
        const res = await fetch('/api/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: r.full_name,
            type: 'repository',
            value: r.html_url,
            description: r.description ?? undefined,
            integration_id: activeId,
            config: r.default_branch ? { branch: r.default_branch } : {},
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          errors.push(`${r.full_name}: ${body.error ?? `HTTP ${res.status}`}`);
        }
      } catch (e) {
        errors.push(`${r.full_name}: ${(e as Error).message}`);
      } finally {
        done++;
        setImportedCount(done);
      }
    }
    setImportInFlight(false);
    setImportErrors(errors);
    if (errors.length === 0) {
      router.push('/targets?imported=' + (targets.length - errors.length));
    }
  }

  const importableSelected = repos
    ? Array.from(selected).filter(
        (id) => repos.find((r) => r.id === id && !r.already_imported),
      ).length
    : 0;

  return (
    <div className="space-y-4">
      {integrations.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Account:
          </span>
          {integrations.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setActiveId(i.id)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors ${
                activeId === i.id
                  ? 'bg-cyan-500/15 text-cyan-100 ring-cyan-400/40'
                  : 'bg-neutral-900/40 text-neutral-400 ring-neutral-800 hover:text-neutral-100'
              }`}
            >
              {i.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-neutral-500" strokeWidth={2.25} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter repos…"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 py-1.5 pl-8 pr-3 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
        </div>
        <button
          type="button"
          onClick={selectAllFiltered}
          disabled={!repos || loading || filtered.length === 0}
          className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 disabled:opacity-50"
        >
          {filtered.length > 0 && filtered.filter((r) => !r.already_imported).every((r) => selected.has(r.id))
            ? 'Deselect all'
            : 'Select all visible'}
        </button>
        <button
          type="button"
          onClick={importPicked}
          disabled={importInFlight || importableSelected === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-950 shadow-sm transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importInFlight ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              Importing {importedCount}/{selected.size}…
            </>
          ) : (
            <>
              Import {importableSelected || ''}{' '}
              {importableSelected === 1 ? 'repo' : 'repos'}
              <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
            </>
          )}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading repositories…
        </div>
      )}

      {loadError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {importErrors.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          <div className="font-semibold">{importErrors.length} import error(s):</div>
          <ul className="mt-1 space-y-0.5">
            {importErrors.slice(0, 5).map((e, i) => (
              <li key={i} className="font-mono text-[11px]">
                {e}
              </li>
            ))}
            {importErrors.length > 5 && (
              <li className="text-amber-300/80">+ {importErrors.length - 5} more</li>
            )}
          </ul>
        </div>
      )}

      {repos && !loading && (
        <>
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-6 py-10 text-center text-sm text-neutral-400">
              No matching repositories.
            </div>
          ) : (
            <ul className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20 divide-y divide-neutral-800/60">
              {filtered.map((r) => {
                const isPicked = selected.has(r.id);
                return (
                  <li
                    key={r.id}
                    className={`flex items-start gap-3 px-4 py-3 ${
                      r.already_imported ? 'opacity-60' : ''
                    } ${isPicked ? 'bg-cyan-500/[0.05]' : 'hover:bg-neutral-900/40'}`}
                  >
                    <label className="mt-0.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        disabled={r.already_imported}
                        onChange={() => toggleRepo(r.id)}
                        className="h-4 w-4 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </label>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-mono text-sm font-medium text-neutral-100">
                          {r.full_name}
                        </span>
                        {r.private && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30">
                            <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />
                            private
                          </span>
                        )}
                        {r.fork && (
                          <span className="inline-flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-neutral-400">
                            <GitFork className="h-2.5 w-2.5" strokeWidth={2.5} />
                            fork
                          </span>
                        )}
                        {r.already_imported && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/30">
                            <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
                            imported
                          </span>
                        )}
                      </div>
                      {r.description && (
                        <div className="mt-0.5 truncate text-[11.5px] text-neutral-400">
                          {r.description}
                        </div>
                      )}
                      <div className="mt-0.5 text-[10.5px] text-neutral-500">
                        {r.pushed_at
                          ? `Last push ${new Date(r.pushed_at).toLocaleDateString()}`
                          : '—'}
                        {r.default_branch ? ` · ${r.default_branch}` : ''}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[10.5px] text-neutral-500">
            Showing {filtered.length} of {repos.length} repos returned by GitHub. Archived repos and
            ones already imported are hidden / disabled. Imported repos inherit the picked
            account&apos;s OAuth token, so private repos clone cleanly on the next scan.
          </p>
        </>
      )}

      {importErrors.length === 0 && importedCount > 0 && !importInFlight && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" strokeWidth={2.5} />
          Imported {importedCount} repo{importedCount === 1 ? '' : 's'}. Redirecting…
        </div>
      )}
    </div>
  );
}
