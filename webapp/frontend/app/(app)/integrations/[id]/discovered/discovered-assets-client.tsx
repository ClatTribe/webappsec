'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  RefreshCw,
  ShieldCheck,
  ExternalLink,
  X,
  AlertCircle,
} from 'lucide-react';

interface DiscoveredAssetRow {
  id: string;
  integration_id: string;
  asset_type: string;
  canonical_id: string;
  display_name: string;
  attributes: Record<string, unknown> | null;
  suggested_config: Record<string, unknown> | null;
  confidence: 'high' | 'medium' | 'low';
  status: 'pending' | 'approved' | 'rejected' | 'imported' | 'superseded';
  target_id: string | null;
  discovered_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
}

interface Props {
  integrationId: string;
  integrationType: string;
  initialPending: DiscoveredAssetRow[];
  initialImported: DiscoveredAssetRow[];
  lastDiscoveryAt: string | null;
}

// Bulk-approve UX. The page is a checklist + the two buttons that
// matter: "approve selected" and "reject selected". Both hit the same
// SECURITY DEFINER RPCs server-side; we re-fetch on success so the
// table re-renders with imported / rejected rows hidden.

export default function DiscoveredAssetsClient({
  integrationId,
  integrationType,
  initialPending,
  initialImported,
  lastDiscoveryAt,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(initialPending);
  const [imported] = useState(initialImported);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | 'discover' | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const filtered = useMemo(() => {
    if (filter === 'all') return pending;
    return pending.filter((a) => a.confidence === filter);
  }, [pending, filter]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => selected.has(a.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    if (allFilteredSelected) {
      const next = new Set(selected);
      for (const a of filtered) next.delete(a.id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const a of filtered) next.add(a.id);
      setSelected(next);
    }
  }

  async function discoverNow() {
    setSubmitting('discover');
    setBanner(null);
    try {
      const res = await fetch(`/api/integrations/${integrationId}/discover`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        assets_upserted?: number;
        errors?: Array<{ discoverer_id: string; error: string }>;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({
          tone: 'error',
          text: body.error ?? 'Discovery failed — see server logs.',
        });
      } else {
        const errStr =
          body.errors && body.errors.length > 0
            ? ` (${body.errors.length} discoverer warning${body.errors.length === 1 ? '' : 's'})`
            : '';
        setBanner({
          tone: 'success',
          text: `Discovered ${body.assets_upserted ?? 0} asset(s)${errStr}. Refreshing…`,
        });
        router.refresh();
      }
    } catch (e) {
      setBanner({
        tone: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(null);
    }
  }

  async function approveSelected() {
    if (selected.size === 0) return;
    setSubmitting('approve');
    setBanner(null);
    try {
      const res = await fetch(`/api/discovered-assets/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset_ids: [...selected],
          config_override: {},
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        imported?: number;
        total?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'error', text: body.error ?? 'Approval failed.' });
      } else {
        setBanner({
          tone: 'success',
          text: `Imported ${body.imported ?? 0} of ${body.total ?? selected.size} asset(s) as targets.`,
        });
        // Optimistic UI: drop approved rows from pending immediately.
        setPending((rows) => rows.filter((r) => !selected.has(r.id)));
        setSelected(new Set());
        router.refresh();
      }
    } catch (e) {
      setBanner({
        tone: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(null);
    }
  }

  async function rejectSelected() {
    if (selected.size === 0) return;
    if (
      !window.confirm(
        `Reject ${selected.size} asset(s)? Re-discovery won't re-surface them unless the underlying resource changes.`,
      )
    ) {
      return;
    }
    setSubmitting('reject');
    setBanner(null);
    try {
      const res = await fetch(`/api/discovered-assets/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: [...selected] }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        rejected?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'error', text: body.error ?? 'Rejection failed.' });
      } else {
        setBanner({
          tone: 'success',
          text: `Rejected ${body.rejected ?? 0} asset(s).`,
        });
        setPending((rows) => rows.filter((r) => !selected.has(r.id)));
        setSelected(new Set());
        router.refresh();
      }
    } catch (e) {
      setBanner({
        tone: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/30 px-4 py-3">
        <button
          type="button"
          onClick={discoverNow}
          disabled={submitting !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${submitting === 'discover' ? 'animate-spin' : ''}`}
            strokeWidth={2.5}
          />
          {submitting === 'discover' ? 'Discovering…' : 'Discover now'}
        </button>

        <span className="mx-2 h-4 border-l border-neutral-700" />

        <span className="text-[11px] text-neutral-400">Filter:</span>
        {(['all', 'high', 'medium', 'low'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-md border px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wider transition-colors ${
              filter === f
                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                : 'border-neutral-700 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600'
            }`}
          >
            {f}
            {f !== 'all' && (
              <span className="ml-1 text-neutral-500">
                {pending.filter((a) => a.confidence === f).length}
              </span>
            )}
          </button>
        ))}

        <span className="flex-1" />

        <button
          type="button"
          onClick={rejectSelected}
          disabled={selected.size === 0 || submitting !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.5} />
          Reject {selected.size > 0 && `(${selected.size})`}
        </button>
        <button
          type="button"
          onClick={approveSelected}
          disabled={selected.size === 0 || submitting !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-1.5 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
          Approve {selected.size > 0 ? `(${selected.size})` : ''} as targets
        </button>
      </div>

      {banner && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
            banner.tone === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {banner.tone === 'success' ? (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" strokeWidth={2.25} />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" strokeWidth={2.25} />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {/* Pending list */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Pending review · {filtered.length}
            {filter !== 'all' && (
              <span className="ml-1.5 normal-case text-neutral-500">
                (filtered from {pending.length})
              </span>
            )}
          </h2>
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-[11px] text-cyan-300 hover:underline"
            >
              {allFilteredSelected ? 'Clear selection' : 'Select all visible'}
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            integrationType={integrationType}
            lastDiscoveryAt={lastDiscoveryAt}
            hasFilter={filter !== 'all'}
            totalPending={pending.length}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {filtered.map((a, i) => (
              <AssetRow
                key={a.id}
                asset={a}
                selected={selected.has(a.id)}
                onToggle={() => toggle(a.id)}
                isLast={i === filtered.length - 1}
              />
            ))}
          </div>
        )}
      </section>

      {/* Already-imported tail */}
      {imported.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Already imported · {imported.length}
          </h2>
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {imported.slice(0, 20).map((a, i, arr) => (
              <ImportedRow
                key={a.id}
                asset={a}
                isLast={i === arr.length - 1}
              />
            ))}
          </div>
          {imported.length > 20 && (
            <p className="mt-2 text-[11px] text-neutral-500">
              + {imported.length - 20} more — visit{' '}
              <Link href="/targets" className="text-cyan-300 hover:underline">
                /targets
              </Link>{' '}
              for the full list.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function AssetRow({
  asset,
  selected,
  onToggle,
  isLast,
}: {
  asset: DiscoveredAssetRow;
  selected: boolean;
  onToggle: () => void;
  isLast: boolean;
}) {
  const attrs = asset.attributes ?? {};
  const url = typeof attrs.upstream_url === 'string' ? attrs.upstream_url : null;
  const description = typeof attrs.description === 'string' ? attrs.description : null;
  const tags = Array.isArray(attrs.tags) ? (attrs.tags as string[]) : [];
  const ageDays = typeof attrs.age_days === 'number' ? (attrs.age_days as number) : null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`grid w-full grid-cols-[auto_auto_1fr_auto_auto] items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-900/50 ${
        isLast ? '' : 'border-b border-neutral-800/60'
      } ${selected ? 'bg-cyan-500/[0.05]' : ''}`}
    >
      <div className="pt-0.5">
        {selected ? (
          <CheckCircle2 className="h-4 w-4 text-cyan-300" strokeWidth={2.5} />
        ) : (
          <Circle className="h-4 w-4 text-neutral-600" strokeWidth={2} />
        )}
      </div>
      <ConfidenceChip confidence={asset.confidence} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100">
            {asset.display_name}
          </span>
          <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
            {asset.asset_type}
          </span>
        </div>
        {description && (
          <p className="mt-0.5 truncate text-[11.5px] text-neutral-400">
            {description}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {tags.slice(0, 5).map((t) => (
            <span
              key={t}
              className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-300"
            >
              {t}
            </span>
          ))}
          {ageDays !== null && (
            <span className="font-mono text-[9.5px] text-neutral-500">
              last touched {ageDays}d ago
            </span>
          )}
        </div>
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="self-center text-neutral-500 transition-colors hover:text-cyan-300"
          title="Open in upstream"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
      <span className="self-center font-mono text-[9.5px] text-neutral-600">
        {asset.canonical_id}
      </span>
    </button>
  );
}

function ImportedRow({
  asset,
  isLast,
}: {
  asset: DiscoveredAssetRow;
  isLast: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 ${
        isLast ? '' : 'border-b border-neutral-800/60'
      }`}
    >
      <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" strokeWidth={2.25} />
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-neutral-200">{asset.display_name}</span>
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
          {asset.asset_type}
        </span>
      </div>
      {asset.target_id ? (
        <Link
          href={`/targets/${asset.target_id}`}
          className="text-[11px] text-cyan-300 hover:underline"
        >
          View target →
        </Link>
      ) : (
        <span className="text-[11px] text-neutral-500">imported</span>
      )}
    </div>
  );
}

function ConfidenceChip({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const t = {
    high: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    medium: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    low: 'bg-neutral-700/40 text-neutral-400 ring-neutral-600/40',
  }[confidence];
  return (
    <span
      className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${t}`}
    >
      {confidence}
    </span>
  );
}

function EmptyState({
  integrationType,
  lastDiscoveryAt,
  hasFilter,
  totalPending,
}: {
  integrationType: string;
  lastDiscoveryAt: string | null;
  hasFilter: boolean;
  totalPending: number;
}) {
  if (hasFilter && totalPending > 0) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-6 text-center text-sm text-neutral-500">
        No assets match this confidence filter. Switch to <strong>all</strong> to see
        the rest.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-6 text-center">
      <p className="text-sm text-neutral-300">
        {lastDiscoveryAt
          ? 'No pending assets — everything discovered so far is either imported or rejected.'
          : 'Discovery hasn\'t run for this integration yet.'}
      </p>
      <p className="mt-1 text-[11px] text-neutral-500">
        {hintForIntegrationType(integrationType)}
      </p>
    </div>
  );
}

function hintForIntegrationType(t: string): string {
  switch (t) {
    case 'github':
      return 'Click "Discover now" above to enumerate repositories this GitHub integration can see.';
    case 'aws':
      return 'Click "Discover now" to enumerate public ALBs, API Gateways, and Lambda function URLs in this AWS account.';
    case 'gcp':
      return 'Click "Discover now" to enumerate public Cloud Run services, App Engine apps, and Cloud Functions in this GCP project.';
    case 'domain':
      return 'Click "Discover now" to enumerate subdomains of this apex via public certificate-transparency logs.';
    default:
      return `Discovery for ${t} integrations: coming soon.`;
  }
}
