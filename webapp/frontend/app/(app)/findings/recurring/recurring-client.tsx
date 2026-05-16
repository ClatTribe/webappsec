'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  ChevronDown,
  Loader2,
  CheckCircle2,
  Eye,
  XCircle,
  AlertCircle,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type {
  FingerprintRollupRow,
  FingerprintTargetRow,
  FindingStatus,
} from '@/lib/supabase/types';

// Tier II #11 — client side of the recurring findings page.
//
// Each row is a fingerprint-rollup; clicking it expands to:
//   - per-target breakdown (status pill per target)
//   - bulk-triage CTA (fix / triaged / wont_fix / false_positive / reopen)
//
// Bulk triage hits POST /api/findings/fingerprints/[fp]/triage which
// only touches `open` rows. The response carries `updated_count` so we
// can show "marked 8 of 12 — 4 already triaged" rather than pretending
// all 12 flipped.

const SEVERITY_PILL: Record<string, string> = {
  critical: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
  high: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
  medium: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  low: 'bg-lime-500/15 text-lime-200 ring-lime-400/30',
  info: 'bg-neutral-700/40 text-neutral-200 ring-neutral-600/40',
};

const STATUS_PILL: Record<FindingStatus, { cls: string; label: string }> = {
  open: { cls: 'bg-rose-500/15 text-rose-200 ring-rose-400/30', label: 'Open' },
  triaged_real: { cls: 'bg-amber-500/15 text-amber-200 ring-amber-400/30', label: 'Real' },
  fixed: { cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30', label: 'Fixed' },
  false_positive: { cls: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40', label: 'FP' },
  wont_fix: { cls: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40', label: 'Won\'t fix' },
  dismissed_by_ai: { cls: 'bg-neutral-700/40 text-neutral-400 ring-neutral-600/40', label: 'AI dismissed' },
};

const URGENCY_PILL: Record<string, string> = {
  fix_now: 'bg-rose-600/20 text-rose-200 ring-rose-500/40',
  fix_soon: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
  monitor: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  dismiss: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
};

interface Props {
  rows: FingerprintRollupRow[];
}

export default function RecurringClient({ rows: initialRows }: Props) {
  const [rows, setRows] = useState<FingerprintRollupRow[]>(initialRows);
  const [expanded, setExpanded] = useState<string | null>(null);

  const handleAfterTriage = (
    fp: string,
    updated_count: number,
    newStatus: FindingStatus,
  ) => {
    // Optimistically reflect the change in the rollup: decrement
    // open_count by the count actually updated, increment the target
    // status bucket by the same amount. Counts in the table are the
    // truth; we re-fetch from the server on the *next* row click to
    // catch out-of-band updates.
    setRows((prev) =>
      prev.map((r) => {
        if (r.fingerprint !== fp) return r;
        const delta = updated_count;
        const next = { ...r, open_count: Math.max(0, r.open_count - delta) };
        switch (newStatus) {
          case 'fixed':
            next.fixed_count = r.fixed_count + delta;
            break;
          case 'wont_fix':
            next.wont_fix_count = r.wont_fix_count + delta;
            break;
          case 'false_positive':
            next.false_positive_count = r.false_positive_count + delta;
            break;
          case 'triaged_real':
            next.triaged_real_count = r.triaged_real_count + delta;
            break;
          default:
            break;
        }
        return next;
      }),
    );
  };

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <RollupRow
          key={r.fingerprint}
          row={r}
          expanded={expanded === r.fingerprint}
          onToggle={() =>
            setExpanded((cur) => (cur === r.fingerprint ? null : r.fingerprint))
          }
          onAfterTriage={(uc, ns) => handleAfterTriage(r.fingerprint, uc, ns)}
        />
      ))}
    </ul>
  );
}

function RollupRow({
  row,
  expanded,
  onToggle,
  onAfterTriage,
}: {
  row: FingerprintRollupRow;
  expanded: boolean;
  onToggle: () => void;
  onAfterTriage: (updated_count: number, newStatus: FindingStatus) => void;
}) {
  return (
    <li className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-900/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-neutral-400" strokeWidth={2.5} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" strokeWidth={2.5} />
        )}

        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${
            SEVERITY_PILL[row.severity] ?? SEVERITY_PILL.info
          }`}
        >
          {row.severity}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate text-[13px] font-medium text-neutral-100">{row.title}</span>
            {row.cwe && <span className="font-mono text-[10.5px] text-neutral-500">{row.cwe}</span>}
            {row.cve && <span className="font-mono text-[10.5px] text-neutral-500">{row.cve}</span>}
            {row.max_urgency && (
              <span
                className={`rounded px-1 py-px text-[9.5px] font-medium uppercase tracking-wider ring-1 ${
                  URGENCY_PILL[row.max_urgency] ?? ''
                }`}
                title={`Highest AI urgency tier across this group: ${row.max_urgency}`}
              >
                {row.max_urgency.replace('_', ' ')}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-neutral-500">
            <span>
              <strong className="text-neutral-300">{row.target_count}</strong> targets
            </span>
            <span>·</span>
            <span>
              <strong className="text-neutral-300">{row.occurrence_count}</strong> occurrences
            </span>
            <span>·</span>
            <span>
              first seen {relativeTime(row.first_seen_at)}
            </span>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5">
          {row.open_count > 0 && (
            <StatusBadge count={row.open_count} status="open" />
          )}
          {row.triaged_real_count > 0 && (
            <StatusBadge count={row.triaged_real_count} status="triaged_real" />
          )}
          {row.fixed_count > 0 && (
            <StatusBadge count={row.fixed_count} status="fixed" />
          )}
          {row.wont_fix_count > 0 && (
            <StatusBadge count={row.wont_fix_count} status="wont_fix" />
          )}
          {row.false_positive_count > 0 && (
            <StatusBadge count={row.false_positive_count} status="false_positive" />
          )}
        </div>
      </button>

      {expanded && (
        <DrillIn
          fingerprint={row.fingerprint}
          openCount={row.open_count}
          onAfterTriage={onAfterTriage}
        />
      )}
    </li>
  );
}

function StatusBadge({ count, status }: { count: number; status: FindingStatus }) {
  const pill = STATUS_PILL[status];
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${pill.cls}`}
      title={`${count} ${pill.label}`}
    >
      {count} {pill.label.toLowerCase()}
    </span>
  );
}

// =============== drill-in (per-target) ============================

function DrillIn({
  fingerprint,
  openCount,
  onAfterTriage,
}: {
  fingerprint: string;
  openCount: number;
  onAfterTriage: (updated_count: number, newStatus: FindingStatus) => void;
}) {
  const supabase = createClient();
  const [rows, setRows] = useState<FingerprintTargetRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Lazy-load per-target detail on first expansion. DrillIn mounts
  // when the parent row's `expanded` flips true, so a useEffect with
  // an empty dep array fires exactly once per expansion lifecycle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('fingerprint_targets', {
        p_fingerprint: fingerprint,
      });
      if (cancelled) return;
      if (error) {
        setErr(error.message);
        setRows([]);
        return;
      }
      setRows((data ?? []) as FingerprintTargetRow[]);
    })();
    return () => {
      cancelled = true;
    };
    // fingerprint is stable for the component's lifetime; supabase
    // is a singleton — neither needs to be in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3 border-t border-neutral-800/80 bg-neutral-950/40 px-4 py-3">
      {/* Bulk-triage CTA bar -------------------------------------- */}
      <BulkTriage
        fingerprint={fingerprint}
        openCount={openCount}
        onAfterTriage={(uc, ns) => {
          onAfterTriage(uc, ns);
          // Refresh local list — server is canonical for per-target state.
          setRows(null);
          void (async () => {
            const { data } = await supabase.rpc('fingerprint_targets', {
              p_fingerprint: fingerprint,
            });
            setRows((data ?? []) as FingerprintTargetRow[]);
          })();
        }}
      />

      {/* Per-target list ---------------------------------------- */}
      <div className="space-y-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
          Seen in
        </div>
        {rows === null ? (
          <div className="py-2 text-[11px] text-neutral-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} />
            Loading targets…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-2 text-[11px] text-neutral-500">No target occurrences found.</div>
        ) : (
          <ul className="divide-y divide-neutral-800/60 rounded-md border border-neutral-800/60 bg-neutral-900/40">
            {rows.map((r) => (
              <li
                key={r.finding_id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-neutral-200">
                      {r.target_name ?? '(unnamed target)'}
                    </span>
                    {r.target_type && (
                      <span className="font-mono text-[10px] text-neutral-500">{r.target_type}</span>
                    )}
                  </div>
                  {r.target_value && (
                    <div className="truncate font-mono text-[10px] text-neutral-500">
                      {r.target_value}
                    </div>
                  )}
                  <div className="text-[10px] text-neutral-600">
                    {r.scan_name} · {relativeTime(r.created_at)}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
                      STATUS_PILL[r.status]?.cls ?? ''
                    }`}
                  >
                    {STATUS_PILL[r.status]?.label ?? r.status}
                  </span>
                  <Link
                    href={`/scans/${r.scan_id}#finding-${r.finding_id}`}
                    className="inline-flex items-center gap-0.5 rounded border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:border-neutral-700"
                    title="Open the finding card in its scan"
                  >
                    open <ExternalLink className="h-2.5 w-2.5" strokeWidth={2.5} />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        {err && <div className="text-[10.5px] text-rose-300">{err}</div>}
      </div>
    </div>
  );
}

// =============== bulk triage panel ================================

function BulkTriage({
  fingerprint,
  openCount,
  onAfterTriage,
}: {
  fingerprint: string;
  openCount: number;
  onAfterTriage: (updated_count: number, newStatus: FindingStatus) => void;
}) {
  const [pending, setPending] = useState<FindingStatus | 'open' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wontFixReason, setWontFixReason] = useState('');
  const [showReason, setShowReason] = useState(false);

  const triage = async (status: FindingStatus | 'open', reason?: string) => {
    if (pending) return;
    if (status === 'wont_fix' && !reason) {
      setShowReason(true);
      return;
    }
    setPending(status);
    setResult(null);
    setErr(null);
    try {
      const res = await fetch(
        `/api/findings/fingerprints/${encodeURIComponent(fingerprint)}/triage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status, reason: reason ?? null }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      const updated = (json.updated_count as number) ?? 0;
      onAfterTriage(updated, status as FindingStatus);
      setResult(
        status === 'open'
          ? `Reopened ${updated} occurrence${updated === 1 ? '' : 's'}.`
          : `Marked ${updated} occurrence${updated === 1 ? '' : 's'} as ${labelOf(status)}.${
              openCount - updated > 0
                ? ` ${openCount - updated} were already triaged — left alone.`
                : ''
            }`,
      );
      setShowReason(false);
      setWontFixReason('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-cyan-200/80">
          Triage as group
        </span>
        <span className="text-[10.5px] text-neutral-500">
          will touch {openCount} open · pre-resolved untouched
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <BulkBtn
          onClick={() => triage('fixed')}
          disabled={pending !== null || openCount === 0}
          loading={pending === 'fixed'}
          tone="emerald"
          Icon={CheckCircle2}
        >
          Mark fixed
        </BulkBtn>
        <BulkBtn
          onClick={() => triage('triaged_real')}
          disabled={pending !== null || openCount === 0}
          loading={pending === 'triaged_real'}
          tone="amber"
          Icon={Eye}
        >
          Confirmed real
        </BulkBtn>
        <BulkBtn
          onClick={() => triage('false_positive')}
          disabled={pending !== null || openCount === 0}
          loading={pending === 'false_positive'}
          tone="neutral"
          Icon={XCircle}
        >
          False positive
        </BulkBtn>
        <BulkBtn
          onClick={() => setShowReason(true)}
          disabled={pending !== null || openCount === 0}
          loading={pending === 'wont_fix'}
          tone="neutral"
          Icon={XCircle}
        >
          Won&apos;t fix
        </BulkBtn>
        <BulkBtn
          onClick={() => triage('open')}
          disabled={pending !== null}
          loading={pending === 'open'}
          tone="blue"
          Icon={RotateCcw}
        >
          Reopen all
        </BulkBtn>
      </div>

      {/* Reason input for wont_fix */}
      {showReason && (
        <div className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-950/60 p-2">
          <textarea
            value={wontFixReason}
            onChange={(e) => setWontFixReason(e.target.value)}
            placeholder="Reason (required) — auditor visible. e.g. 'Internal-only endpoint, behind VPN, compensating control: WAF rule R-1234.'"
            rows={2}
            maxLength={2048}
            className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[11.5px] text-neutral-100 placeholder:text-neutral-600"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowReason(false);
                setWontFixReason('');
              }}
              className="text-[10.5px] text-neutral-500 hover:text-neutral-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => triage('wont_fix', wontFixReason.trim())}
              disabled={!wontFixReason.trim() || pending !== null}
              className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-2 py-1 text-[10.5px] font-medium text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/25 disabled:opacity-50"
            >
              {pending === 'wont_fix' && (
                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
              )}
              Accept risk
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="flex items-start gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/[0.05] px-2 py-1.5 text-[11px] text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-300" strokeWidth={2.5} />
          {result}
        </div>
      )}
      {err && (
        <div className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-rose-300" strokeWidth={2.5} />
          {err}
        </div>
      )}
    </div>
  );
}

function BulkBtn({
  children,
  onClick,
  disabled,
  loading,
  tone,
  Icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  tone: 'emerald' | 'amber' | 'neutral' | 'blue';
  Icon: typeof CheckCircle2;
}) {
  const cls = {
    emerald: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30 hover:bg-emerald-500/25',
    amber: 'bg-amber-500/15 text-amber-200 ring-amber-400/30 hover:bg-amber-500/25',
    neutral: 'bg-neutral-800 text-neutral-200 ring-neutral-700 hover:bg-neutral-700',
    blue: 'bg-blue-500/15 text-blue-200 ring-blue-400/30 hover:bg-blue-500/25',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium ring-1 ${cls} disabled:opacity-50`}
    >
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
      ) : (
        <Icon className="h-3 w-3" strokeWidth={2.5} />
      )}
      {children}
    </button>
  );
}

// =============== utils ============================================

function labelOf(s: FindingStatus | 'open'): string {
  if (s === 'open') return 'open';
  return STATUS_PILL[s]?.label.toLowerCase() ?? s;
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2_592_000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
