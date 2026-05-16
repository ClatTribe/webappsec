'use client';

import { useEffect, useState } from 'react';
import { User, X, Calendar, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

// Tier I #6 — finding assignee + due-date picker.
//
// Inline editor that sits in the Triage section of finding-card.tsx.
// One round-trip to load org members on mount, one PATCH per change.
//
// Behaviours:
//   - Unset:        chip says "Unassigned" + click opens picker.
//   - Set:          chip shows "<name> · due in 5d" with an × to clear.
//   - Due-soon:     amber chip when due_at within 24h.
//   - Past due:     rose chip with "overdue Nd".
//
// We deliberately avoid a fancy modal — the picker is a small popover
// list of members. The org is small (most TensorShield customers are
// ≤ 20-person eng orgs) so a search box isn't needed yet.

interface Member {
  user_id: string;
  full_name: string | null;
}

interface Props {
  findingId: string;
  orgId: string;
  initialAssigneeId: string | null;
  initialDueAt: string | null;
  // Profile lookup for the currently-assigned user, when the parent
  // already has the name. Saves a round-trip if available.
  initialAssigneeName?: string | null;
}

export default function AssigneePicker({
  findingId,
  orgId,
  initialAssigneeId,
  initialDueAt,
  initialAssigneeName = null,
}: Props) {
  const supabase = createClient();
  const [assigneeId, setAssigneeId] = useState<string | null>(initialAssigneeId);
  const [assigneeName, setAssigneeName] = useState<string | null>(initialAssigneeName);
  const [dueAt, setDueAt] = useState<string | null>(initialDueAt);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Lazy-load members the first time the picker opens — saves a
  // round-trip when the user only views findings.
  useEffect(() => {
    if (!open || members) return;
    let cancelled = false;
    (async () => {
      const { data: memberRows } = await supabase
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      const ids = (memberRows ?? []).map((r) => r.user_id);
      if (ids.length === 0) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', ids);
      const byId = new Map((profileRows ?? []).map((p) => [p.id, p.full_name as string | null]));
      const merged: Member[] = ids
        .map((id) => ({ user_id: id, full_name: byId.get(id) ?? null }))
        .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
      if (!cancelled) setMembers(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, members, orgId, supabase]);

  const assign = async (m: Member) => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/findings/${findingId}/assignee`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignee_id: m.user_id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setAssigneeId(m.user_id);
      setAssigneeName(m.full_name);
      if (json.due_at) setDueAt(json.due_at);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/findings/${findingId}/assignee`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setAssigneeId(null);
      setAssigneeName(null);
      setDueAt(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSaving(false);
    }
  };

  const dueChip = dueAt ? renderDueChip(dueAt) : null;

  return (
    <div className="relative inline-flex flex-wrap items-center gap-2">
      {assigneeId ? (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-200 ring-1 ring-cyan-400/30">
          <User className="h-3 w-3" strokeWidth={2.25} />
          {assigneeName ?? 'Assigned'}
          <button
            type="button"
            onClick={clear}
            disabled={saving}
            title="Clear assignee"
            className="rounded p-0.5 text-cyan-300/80 hover:bg-cyan-500/20 hover:text-cyan-100 disabled:opacity-50"
          >
            <X className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-800/80 px-2 py-0.5 text-[11px] font-medium text-neutral-300 ring-1 ring-neutral-700 hover:bg-neutral-700/80"
        >
          <User className="h-3 w-3" strokeWidth={2.25} />
          Unassigned
        </button>
      )}

      {assigneeId && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[10.5px] text-neutral-500 hover:text-neutral-300"
          disabled={saving}
        >
          change
        </button>
      )}

      {dueChip}

      {saving && <Loader2 className="h-3 w-3 animate-spin text-neutral-500" strokeWidth={2.5} />}
      {err && <span className="text-[10.5px] text-rose-300">{err}</span>}

      {open && (
        <div
          role="dialog"
          className="absolute top-full z-20 mt-1.5 w-64 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-xl"
        >
          <div className="border-b border-neutral-800 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
            Assign to
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            {members === null && (
              <li className="px-3 py-2 text-[11px] text-neutral-500">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} />
                Loading members…
              </li>
            )}
            {members?.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-neutral-500">
                No other members in this org yet.
              </li>
            )}
            {members?.map((m) => (
              <li key={m.user_id}>
                <button
                  type="button"
                  onClick={() => assign(m)}
                  disabled={saving || m.user_id === assigneeId}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11.5px] text-neutral-200 hover:bg-cyan-500/10 disabled:opacity-40"
                >
                  <span>{m.full_name ?? m.user_id.slice(0, 8)}</span>
                  {m.user_id === assigneeId && (
                    <span className="text-[10px] text-cyan-300">current</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function renderDueChip(dueAtIso: string) {
  const due = Date.parse(dueAtIso);
  if (!Number.isFinite(due)) return null;
  const diffMs = due - Date.now();
  const diffDays = diffMs / 86_400_000;

  let tone = 'bg-neutral-800/70 text-neutral-300 ring-neutral-700';
  let label: string;
  if (diffMs < 0) {
    const overdue = Math.abs(diffDays);
    tone = 'bg-rose-500/15 text-rose-200 ring-rose-400/30';
    label = `overdue ${formatDays(overdue)}`;
  } else if (diffMs < 86_400_000) {
    tone = 'bg-amber-500/15 text-amber-200 ring-amber-400/30';
    label = `due in <24h`;
  } else {
    label = `due in ${formatDays(diffDays)}`;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium ring-1 ${tone}`}
      title={new Date(due).toLocaleString()}
    >
      <Calendar className="h-3 w-3" strokeWidth={2.25} />
      {label}
    </span>
  );
}

function formatDays(d: number): string {
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 14) return `${Math.round(d)}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}
