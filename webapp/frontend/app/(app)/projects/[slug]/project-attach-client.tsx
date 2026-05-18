'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Link2,
  AlertCircle,
} from 'lucide-react';

interface UnattachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
}

// Bulk-attach widget on the project detail page. The list comes
// server-rendered from the page; this client component only handles
// selection + the attach POST.

export default function ProjectAttachClient({
  projectId,
  unattached,
}: {
  projectId: string;
  unattached: UnattachedTarget[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const [filter, setFilter] = useState('');

  const filtered = unattached.filter((t) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.value.toLowerCase().includes(q) ||
      t.type.toLowerCase().includes(q)
    );
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function attach() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_ids: [...selected] }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        attached?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Attach failed.' });
        return;
      }
      setBanner({
        tone: 'ok',
        text: `Attached ${body.attached ?? 0} target(s). Refreshing…`,
      });
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setBanner({
        tone: 'err',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <Link2 className="h-3 w-3" strokeWidth={2.25} />
            Attach more targets
          </h2>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            {unattached.length} unattached target{unattached.length === 1 ? '' : 's'}{' '}
            in your org · select to attach
          </p>
        </div>
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
            onClick={attach}
            disabled={submitting || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 disabled:opacity-50"
          >
            <Link2 className="h-3 w-3" strokeWidth={2.5} />
            Attach {selected.size > 0 && `(${selected.size})`}
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
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

      <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/40">
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-neutral-500">
            {unattached.length === 0
              ? 'Every asset is already attached to a project. Create more in /assets/new.'
              : 'No matches for that filter.'}
          </p>
        ) : (
          filtered.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle(t.id)}
              className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-900/50 ${
                i < filtered.length - 1 ? 'border-b border-neutral-800/40' : ''
              } ${selected.has(t.id) ? 'bg-cyan-500/[0.05]' : ''}`}
            >
              {selected.has(t.id) ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" strokeWidth={2.5} />
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
  );
}
