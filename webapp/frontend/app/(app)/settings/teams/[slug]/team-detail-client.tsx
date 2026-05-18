'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Link2,
  Unlink,
  AlertCircle,
  CheckCircle2,
  Circle,
  Trash2,
  UserPlus,
  UserX,
} from 'lucide-react';

interface Team {
  id: string;
  slug: string;
  name: string;
}

interface MemberRow {
  user_id: string;
  role: 'member' | 'lead';
  added_at: string;
}

interface AttachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
}

// Team detail — bulk-attach targets, bulk-add members by user_id,
// archive team. Keep it functional rather than pretty for v1; full
// people-picker + autocomplete come in a follow-up.

export default function TeamDetailClient({
  team,
  members,
  attachedTargets,
  unattachedTargets,
}: {
  team: Team;
  members: MemberRow[];
  attachedTargets: AttachedTarget[];
  unattachedTargets: AttachedTarget[];
}) {
  const router = useRouter();
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [newMemberUserId, setNewMemberUserId] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<'member' | 'lead'>('member');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<'attach' | 'detach' | 'add' | 'remove' | 'archive' | null>(
    null,
  );
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  );

  const filtered = unattachedTargets.filter((t) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.value.toLowerCase().includes(q);
  });

  function toggleTarget(id: string) {
    const n = new Set(selectedTargets);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelectedTargets(n);
  }

  async function attachTargets() {
    if (selectedTargets.size === 0) return;
    setBusy('attach');
    setBanner(null);
    try {
      const res = await fetch(`/api/teams/${team.slug}/targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_ids: [...selectedTargets] }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        attached?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Attach failed.' });
      } else {
        setBanner({ tone: 'ok', text: `Attached ${body.attached ?? 0} target(s).` });
        setSelectedTargets(new Set());
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function detachTarget(targetId: string) {
    setBusy('detach');
    setBanner(null);
    try {
      const res = await fetch(`/api/teams/${team.slug}/targets`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_ids: [targetId] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: 'err', text: body.error ?? 'Detach failed.' });
      } else {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function addMember() {
    const uid = newMemberUserId.trim();
    if (!uid) return;
    setBusy('add');
    setBanner(null);
    try {
      const res = await fetch(`/api/teams/${team.slug}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: uid, role: newMemberRole }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Add member failed.' });
      } else {
        setBanner({ tone: 'ok', text: 'Member added.' });
        setNewMemberUserId('');
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(userId: string) {
    setBusy('remove');
    setBanner(null);
    try {
      const res = await fetch(`/api/teams/${team.slug}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: 'err', text: body.error ?? 'Remove failed.' });
      } else {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function archiveTeam() {
    if (!window.confirm(`Archive "${team.name}"? Members keep their access until you rewire scopes.`)) {
      return;
    }
    setBusy('archive');
    setBanner(null);
    try {
      const res = await fetch(`/api/teams/${team.slug}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: 'err', text: body.error ?? 'Archive failed.' });
      } else {
        router.push('/settings/teams');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {banner && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            banner.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {banner.tone === 'ok' ? (
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.25} />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {/* Members */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Members · {members.length}
        </h2>
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="space-y-1.5">
            {members.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No members yet. Add by user_id below.
              </p>
            ) : (
              members.map((m) => (
                <div
                  key={m.user_id}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-md bg-neutral-950/40 px-3 py-2"
                >
                  <span className="font-mono text-[11px] text-neutral-300">
                    {m.user_id}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${
                      m.role === 'lead'
                        ? 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30'
                        : 'bg-neutral-700/40 text-neutral-300'
                    }`}
                  >
                    {m.role}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMember(m.user_id)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/60 px-2 py-1 text-[10.5px] font-medium text-neutral-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
                  >
                    <UserX className="h-3 w-3" strokeWidth={2.5} />
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <input
              type="text"
              value={newMemberUserId}
              onChange={(e) => setNewMemberUserId(e.target.value)}
              placeholder="user UUID (find on /team)"
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs"
            />
            <select
              value={newMemberRole}
              onChange={(e) => setNewMemberRole(e.target.value as 'member' | 'lead')}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            >
              <option value="member">member</option>
              <option value="lead">lead</option>
            </select>
            <button
              type="button"
              onClick={addMember}
              disabled={busy !== null || !newMemberUserId.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1 text-xs font-semibold text-neutral-950 disabled:opacity-50"
            >
              <UserPlus className="h-3 w-3" strokeWidth={2.5} />
              Add member
            </button>
          </div>
          <p className="mt-2 text-[10.5px] text-neutral-500">
            Tip: paste the user UUID from <code className="font-mono">/team</code>.
            A full people-picker is a follow-up.
          </p>
        </div>
      </section>

      {/* Attached targets */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Targets owned · {attachedTargets.length}
        </h2>
        {attachedTargets.length === 0 ? (
          <p className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-4 text-center text-sm text-neutral-500">
            No targets attached yet. Use the panel below.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {attachedTargets.map((t, i) => (
              <div
                key={t.id}
                className={`grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2.5 ${
                  i < attachedTargets.length - 1
                    ? 'border-b border-neutral-800/60'
                    : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-neutral-100">{t.name}</span>
                    <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
                      {t.type}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[10.5px] text-neutral-500">
                    {t.value}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => detachTarget(t.id)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/60 px-2 py-1 text-[10.5px] font-medium text-neutral-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
                >
                  <Unlink className="h-3 w-3" strokeWidth={2.5} />
                  Detach
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Attach widget */}
      {unattachedTargets.length > 0 && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <Link2 className="h-3 w-3" strokeWidth={2.25} />
              Attach more targets
            </h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="w-44 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={attachTargets}
                disabled={busy !== null || selectedTargets.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 disabled:opacity-50"
              >
                <Link2 className="h-3 w-3" strokeWidth={2.5} />
                Attach{' '}
                {selectedTargets.size > 0 && `(${selectedTargets.size})`}
              </button>
            </div>
          </div>

          <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/40">
            {filtered.length === 0 ? (
              <p className="p-3 text-center text-xs text-neutral-500">No matches.</p>
            ) : (
              filtered.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTarget(t.id)}
                  className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-900/50 ${
                    i < filtered.length - 1 ? 'border-b border-neutral-800/40' : ''
                  } ${selectedTargets.has(t.id) ? 'bg-cyan-500/[0.05]' : ''}`}
                >
                  {selectedTargets.has(t.id) ? (
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-cyan-300"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-neutral-600" strokeWidth={2} />
                  )}
                  <div className="min-w-0">
                    <span className="block truncate text-[12.5px] text-neutral-100">
                      {t.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-neutral-500">
                      {t.value}
                    </span>
                  </div>
                  <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
                    {t.type}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {/* Archive */}
      <section>
        <button
          type="button"
          onClick={archiveTeam}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2.5} />
          Archive team
        </button>
      </section>
    </div>
  );
}
