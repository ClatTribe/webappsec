'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ScanLine, Sparkles, Target as TargetIcon, Loader2, X } from 'lucide-react';
import FindingCard from './finding-card';
import type { AiUrgency, Finding, FindingStatus } from '@/lib/supabase/types';
import { AI_BRAND } from '@/lib/finding-theme';
import { createClient } from '@/lib/supabase/client';
import { resolveDriftClassification } from '@/lib/cloud-attack-path';

type FindingWithScan = Finding & {
  scans?: { run_name: string; status: string } | null;
  last_seen_scan?: { run_name: string } | null;
  targets?: { name: string; value: string; type: string } | null;
  finding_occurrences?: {
    scan_id: string;
    seen_at: string;
    reopened: boolean;
    scans?: { run_name: string } | null;
  }[] | null;
};

const ALL_TARGETS = '__all__';

// Statuses that count as "resolved" for the default Open / Urgent views.
// `dismissed_by_ai` is included here — those are findings the model auto-
// hid; they shouldn't clutter the default list. The "All" view shows them,
// and the dedicated "AI dismissed" tab lets the user audit + override.
const RESOLVED_STATUSES = new Set(['fixed', 'false_positive', 'wont_fix', 'dismissed_by_ai']);

const URGENCY_RANK: Record<AiUrgency, number> = {
  fix_now: 0,
  fix_soon: 1,
  monitor: 2,
  dismiss: 3,
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

type ViewMode = 'urgent' | 'open' | 'ai_dismissed' | 'all';

const VIEW_MODES: { value: ViewMode; label: string; help: string }[] = [
  {
    value: 'urgent',
    label: 'Urgent',
    help: 'AI says fix-now or fix-soon, hides everything else.',
  },
  {
    value: 'open',
    label: 'Open',
    help: 'Anything not yet fixed / dismissed / wont-fix.',
  },
  {
    value: 'ai_dismissed',
    label: 'AI dismissed',
    help: 'Findings the model auto-hid. Review and override if needed.',
  },
  {
    value: 'all',
    label: 'All',
    help: 'Including resolved and AI-dismissed findings.',
  },
];

// Phase B #1 — multi-axis filter chips. Each axis is independent; a
// finding shows only when it passes ALL active filters (AND
// semantics). Empty set on an axis = no filter (everything passes).
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low', 'info'] as const;
const VERIFICATION_OPTIONS = ['exploited', 'verified', 'pattern_match'] as const;

const SEVERITY_CHIP_TONE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-200 ring-red-500/30',
  high: 'bg-orange-500/15 text-orange-200 ring-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-200 ring-amber-500/30',
  low: 'bg-lime-500/15 text-lime-200 ring-lime-500/30',
  info: 'bg-neutral-700/40 text-neutral-200 ring-neutral-600/40',
};

// Wishlist §17.4 — drift classification filter row. Only renders when
// the page has at least one drift-classified finding (engine PR #292).
// `__all__` is the no-filter sentinel mirroring ALL_TARGETS.
type DriftFilterValue =
  | '__all__'
  | 'iac_root_cause'
  | 'drift'
  | 'iac_unfollowed'
  | 'uncorrelated_cspm';

const DRIFT_FILTER_OPTIONS: { value: DriftFilterValue; label: string; help: string }[] = [
  { value: '__all__',          label: 'All',            help: 'Show every finding regardless of drift state.' },
  { value: 'drift',            label: 'Drift only',     help: 'CSPM-only: resource drifted out of IaC. Fix by realigning IaC.' },
  { value: 'iac_root_cause',   label: 'IaC root cause', help: 'Both IaC and live agree — fix the IaC and re-apply.' },
  { value: 'iac_unfollowed',   label: 'IaC unfollowed', help: 'IaC declares the misconfig but live is clean — IaC un-applied.' },
  { value: 'uncorrelated_cspm', label: 'CSPM-only',     help: 'Live-only attestation; no IaC analog.' },
];

export default function FindingsFilter({ findings }: { findings: FindingWithScan[] }) {
  const [view, setView] = useState<ViewMode>('open');
  const [targetFilter, setTargetFilter] = useState<string>(ALL_TARGETS);
  // Phase B #1 — multi-axis filter state.
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set());
  const [verificationFilter, setVerificationFilter] = useState<Set<string>>(new Set());
  // Wishlist §17.4 — drift classification filter.
  const [driftFilter, setDriftFilter] = useState<DriftFilterValue>('__all__');
  // Phase B #1 — bulk selection state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkInFlight, setBulkInFlight] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Distinct targets present in this list, name-sorted, for the filter dropdown.
  const targetOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of findings) {
      if (f.target_id && f.targets?.name) {
        seen.set(f.target_id, f.targets.name);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [findings]);

  const targetFiltered = useMemo(() => {
    if (targetFilter === ALL_TARGETS) return findings;
    return findings.filter((f) => f.target_id === targetFilter);
  }, [findings, targetFilter]);

  const sorted = useMemo(() => {
    const arr = [...targetFiltered];
    arr.sort((a, b) => {
      const ua = URGENCY_RANK[a.ai_assessment?.urgency ?? 'monitor'];
      const ub = URGENCY_RANK[b.ai_assessment?.urgency ?? 'monitor'];
      if (ua !== ub) return ua - ub;
      const sa = SEVERITY_RANK[a.severity] ?? 99;
      const sb = SEVERITY_RANK[b.severity] ?? 99;
      return sa - sb;
    });
    return arr;
  }, [targetFiltered]);

  const visible = useMemo(() => {
    return sorted.filter((f) => {
      const isResolved = RESOLVED_STATUSES.has(f.status);
      // View-mode gate.
      if (view === 'ai_dismissed') {
        if (f.status !== 'dismissed_by_ai') return false;
      } else if (view === 'open') {
        if (isResolved) return false;
      } else if (view === 'urgent') {
        const u = f.ai_assessment?.urgency;
        const isUrgent =
          (u && (u === 'fix_now' || u === 'fix_soon')) ||
          (!f.ai_assessment && (f.severity === 'critical' || f.severity === 'high'));
        if (!isUrgent || isResolved) return false;
      }
      // Phase B #1 — multi-axis chip filters (AND).
      if (severityFilter.size > 0 && !severityFilter.has(f.severity)) return false;
      if (verificationFilter.size > 0) {
        const v = f.verification_status ?? '';
        if (!verificationFilter.has(v)) return false;
      }
      // Wishlist §17.4 — drift classification (AND with other filters).
      // Reads via the same helper FindingCard uses, so the filter row
      // matches the badges 1:1.
      if (driftFilter !== '__all__') {
        const { classification } = resolveDriftClassification(f);
        if (classification !== driftFilter) return false;
      }
      return true;
    });
  }, [sorted, view, severityFilter, verificationFilter, driftFilter]);

  // Only render the drift filter row when at least one finding in
  // this dataset carries a drift classification. Keeps the toolbar
  // clean for non-cloud scans.
  const hasDriftFindings = useMemo(
    () => findings.some((f) => resolveDriftClassification(f).classification !== null),
    [findings],
  );

  // A single, calm count — what's currently visible.
  const totalForView = visible.length;
  const totalAll = findings.length;
  const activeFilterChips =
    severityFilter.size + verificationFilter.size + (targetFilter !== ALL_TARGETS ? 1 : 0);

  function toggleInSet(setter: (next: Set<string>) => void, current: Set<string>, value: string) {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  function clearAllFilters() {
    setSeverityFilter(new Set());
    setVerificationFilter(new Set());
    setTargetFilter(ALL_TARGETS);
    setDriftFilter('__all__');
  }

  // Phase B #1 — bulk-select helpers.
  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function selectAllVisible() {
    if (visible.length === selected.size && visible.every((f) => selected.has(f.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visible.map((f) => f.id)));
    }
  }

  async function bulkTriage(newStatus: FindingStatus) {
    if (bulkInFlight || selected.size === 0) return;
    setBulkInFlight(true);
    setBulkError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const update: Record<string, unknown> = {
      status: newStatus,
      triaged_by: newStatus === 'open' ? null : user?.id ?? null,
      triaged_at: newStatus === 'open' ? null : new Date().toISOString(),
    };
    // Clear acceptance metadata when bulk-moving out of wont_fix.
    if (newStatus !== 'wont_fix') {
      update.wont_fix_reason = null;
      update.risk_acceptance_expires_at = null;
    }
    const { error } = await supabase
      .from('findings')
      .update(update)
      .in('id', Array.from(selected));
    setBulkInFlight(false);
    if (error) {
      setBulkError(error.message);
      return;
    }
    // Best-effort: reload to pick up server-truth + drop the
    // selection. A future enhancement could optimistically update the
    // in-memory list without a full reload.
    if (typeof window !== 'undefined') window.location.reload();
  }

  const allVisibleSelected =
    visible.length > 0 && visible.every((f) => selected.has(f.id));

  return (
    <div className="space-y-5">
      {/* Filter row — view-mode pills + target dropdown + count */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800/80">
          {VIEW_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setView(m.value)}
              title={m.help}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                view === m.value
                  ? 'bg-neutral-800 text-neutral-50'
                  : 'text-neutral-400 hover:text-neutral-100'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {targetOptions.length > 0 && (
          <div className="relative inline-flex items-center">
            <TargetIcon
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-cyan-400/70"
              strokeWidth={2.25}
            />
            <select
              value={targetFilter}
              onChange={(e) => setTargetFilter(e.target.value)}
              className="appearance-none rounded-lg border border-neutral-800 bg-neutral-900/60 py-1.5 pl-8 pr-7 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            >
              <option value={ALL_TARGETS}>All targets</option>
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 text-neutral-500">▾</span>
          </div>
        )}

        <span className="ml-auto text-[11px] text-neutral-500">
          {totalForView} of {totalAll}
        </span>
      </div>

      {/* Phase B #1 — multi-axis filter chip row. Severity + verification
          stay on their own line so users can stack filters without the
          view-mode pills jumping around. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10.5px]">
        <span className="font-semibold uppercase tracking-wider text-neutral-500">Severity:</span>
        {SEVERITY_OPTIONS.map((s) => {
          const active = severityFilter.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleInSet(setSeverityFilter, severityFilter, s)}
              className={`rounded-md px-2 py-0.5 font-medium uppercase tracking-wider ring-1 transition-colors ${
                active
                  ? SEVERITY_CHIP_TONE[s]
                  : 'bg-neutral-900/40 text-neutral-500 ring-neutral-800 hover:text-neutral-300'
              }`}
            >
              {s}
            </button>
          );
        })}
        <span className="ml-3 font-semibold uppercase tracking-wider text-neutral-500">
          Verification:
        </span>
        {VERIFICATION_OPTIONS.map((v) => {
          const active = verificationFilter.has(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => toggleInSet(setVerificationFilter, verificationFilter, v)}
              className={`rounded-md px-2 py-0.5 font-medium uppercase tracking-wider ring-1 transition-colors ${
                active
                  ? v === 'exploited'
                    ? 'bg-red-500/20 text-red-100 ring-red-400/40'
                    : v === 'verified'
                      ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30'
                      : 'bg-amber-500/10 text-amber-200 ring-amber-400/30'
                  : 'bg-neutral-900/40 text-neutral-500 ring-neutral-800 hover:text-neutral-300'
              }`}
            >
              {v.replace(/_/g, ' ')}
            </button>
          );
        })}
        {activeFilterChips > 0 && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-neutral-400 hover:text-neutral-100"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
            Clear filters
          </button>
        )}
      </div>

      {/* Wishlist §17.4 — drift classification filter row. Conditional
          so this row never appears on the typical web-app-only scan;
          shows up the moment a CSPM + IaC mixed scan produces drift-
          classified findings. */}
      {hasDriftFindings && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-orange-500/15 bg-orange-500/[0.03] px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-orange-200/80">
            Drift:
          </span>
          {DRIFT_FILTER_OPTIONS.map((opt) => {
            const active = driftFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDriftFilter(opt.value)}
                title={opt.help}
                className={`rounded-md px-2 py-0.5 font-medium ring-1 transition-colors ${
                  active
                    ? 'bg-orange-500/20 text-orange-100 ring-orange-400/40'
                    : 'bg-neutral-900/40 text-neutral-500 ring-neutral-800 hover:text-neutral-300'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {/* AI explainer — the only thing on the page that uses the AI gradient. */}
      <div className="flex items-start gap-2 px-1 text-[11px] text-neutral-500">
        <Sparkles className={`mt-0.5 h-3 w-3 flex-shrink-0 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
        <p>
          AI triage filters out likely false positives and ranks the rest by reachability and
          impact. Switch to <em>All</em> to see everything.
        </p>
      </div>

      {/* Phase B #1 — bulk action bar. Hidden when nothing is selected.
          Sticky-on-scroll keeps it accessible across long inbox views. */}
      {visible.length > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-neutral-800/80 bg-neutral-950/80 px-3 py-2 backdrop-blur">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={selectAllVisible}
              className="h-3.5 w-3.5 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            />
            {allVisibleSelected ? 'Deselect all' : 'Select all visible'}
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-[11px] text-neutral-300">
                <strong className="text-neutral-100">{selected.size}</strong> selected
              </span>
              <span className="text-neutral-700">·</span>
              <button
                type="button"
                disabled={bulkInFlight}
                onClick={() => bulkTriage('fixed')}
                className="rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
              >
                Mark fixed
              </button>
              <button
                type="button"
                disabled={bulkInFlight}
                onClick={() => bulkTriage('false_positive')}
                className="rounded-md bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-200 ring-1 ring-rose-400/30 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
              >
                False positive
              </button>
              <button
                type="button"
                disabled={bulkInFlight}
                onClick={() => bulkTriage('open')}
                className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 ring-1 ring-neutral-700 transition-colors hover:bg-neutral-700 disabled:opacity-50"
              >
                Reopen
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="ml-auto text-[11px] text-neutral-400 hover:text-neutral-100"
              >
                Clear selection
              </button>
              {bulkInFlight && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={2.5} />
              )}
            </>
          )}
        </div>
      )}
      {bulkError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
          Bulk triage failed: {bulkError}
        </div>
      )}

      <div className="space-y-3">
        {visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-12 text-center">
            <p className="text-sm text-neutral-300">
              {view === 'urgent'
                ? 'No urgent findings — nothing the AI thinks needs immediate action.'
                : view === 'open'
                ? 'No open findings — everything has been triaged.'
                : view === 'ai_dismissed'
                ? "No AI-dismissed findings — the model hasn't auto-dismissed anything for this org yet."
                : 'No findings match the current filter.'}
            </p>
            {findings.length > 0 && view !== 'all' && (
              <button
                type="button"
                onClick={() => setView('all')}
                className="mt-3 text-xs text-cyan-300 hover:underline"
              >
                Show all {findings.length} (including resolved & dismissed) →
              </button>
            )}
          </div>
        ) : (
          visible.map((f) => (
            <div key={f.id} className="flex items-start gap-2">
              {/* Phase B #1 — per-card select checkbox. Stays outside
                  the card so it doesn't compete with the card's own
                  click affordances (expand, triage buttons). */}
              <label className="mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggleSelect(f.id)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
                />
              </label>
              <div className="min-w-0 flex-1">
                {(f.targets || f.scans?.run_name) && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px] text-neutral-500">
                    {f.targets && f.target_id && (
                      <span className="inline-flex items-center gap-1">
                        <TargetIcon className="h-3 w-3 text-cyan-400/70" strokeWidth={2.25} />
                        <Link
                          href={`/targets/${f.target_id}`}
                          className="font-medium text-neutral-300 transition-colors hover:text-cyan-300"
                        >
                          {f.targets.name}
                        </Link>
                      </span>
                    )}
                    {f.scans?.run_name && (
                      <span className="inline-flex items-center gap-1">
                        <ScanLine className="h-3 w-3" strokeWidth={2} />
                        <Link
                          href={`/scans/${f.scan_id}`}
                          className="text-neutral-400 transition-colors hover:text-cyan-300"
                        >
                          {f.scans.run_name}
                        </Link>
                      </span>
                    )}
                  </div>
                )}
                <FindingCard finding={f} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
