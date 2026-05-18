'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Moon,
  RotateCcw,
  Archive,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';

interface DormantTarget {
  id: string;
  name: string;
  type: string;
  value: string;
  dormancy_reason: string | null;
  dormancy_detected_at: string | null;
  last_scan_at: string | null;
}

// Phase F dormant assets panel. Collapsible because most days the
// customer doesn't need to think about this; when they do they want
// it batch-actionable.

const REASON_LABEL: Record<string, string> = {
  no_recent_scans: 'No scans in 90+ days',
  never_scanned: 'Registered but never scanned',
  integration_removed: 'Linked integration is gone',
};

export default function DormantTargetsClient({
  targets,
}: {
  targets: DormantTarget[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  );

  async function restore(id: string) {
    setBusy(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/targets/${id}/restore`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Restore failed.' });
      } else {
        setBanner({ tone: 'ok', text: 'Target restored to active. Refreshing…' });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function archive(id: string) {
    if (
      !window.confirm(
        'Archive this target? It will stop scanning and disappear from the active list (kept for audit).',
      )
    ) {
      return;
    }
    setBusy(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/targets/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: 'err', text: body.error ?? 'Archive failed.' });
      } else {
        setBanner({ tone: 'ok', text: 'Target archived. Refreshing…' });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-amber-500/[0.06]"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-amber-300" strokeWidth={2.25} />
          ) : (
            <ChevronRight className="h-4 w-4 text-amber-300" strokeWidth={2.25} />
          )}
          <Moon className="h-4 w-4 text-amber-300" strokeWidth={2.25} />
          <span className="text-sm font-semibold text-amber-200">
            {targets.length} dormant target{targets.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="hidden text-[11px] text-amber-200/80 sm:block">
          No recent activity detected — review and restore or archive
        </p>
      </button>

      {open && (
        <div className="space-y-2 border-t border-amber-500/20 px-4 py-3">
          {banner && (
            <div
              className={`mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                banner.tone === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
            >
              <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.25} />
              <span>{banner.text}</span>
            </div>
          )}

          {targets.map((t) => (
            <div
              key={t.id}
              className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-neutral-100">{t.name}</span>
                  <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
                    {t.type}
                  </span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9.5px] text-amber-200 ring-1 ring-amber-500/30">
                    {t.dormancy_reason
                      ? REASON_LABEL[t.dormancy_reason] ?? t.dormancy_reason
                      : 'unknown'}
                  </span>
                </div>
                <p className="truncate font-mono text-[10.5px] text-neutral-500">
                  {t.value}
                </p>
                <p className="mt-0.5 text-[10.5px] text-neutral-600">
                  Last scan:{' '}
                  {t.last_scan_at
                    ? new Date(t.last_scan_at).toLocaleDateString()
                    : 'never'}
                  {t.dormancy_detected_at && (
                    <span className="ml-2">
                      · Flagged{' '}
                      {new Date(t.dormancy_detected_at).toLocaleDateString()}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => restore(t.id)}
                  disabled={busy === t.id}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/60 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:border-emerald-500/40 hover:text-emerald-200 disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" strokeWidth={2.5} />
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => archive(t.id)}
                  disabled={busy === t.id}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/60 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
                >
                  <Archive className="h-3 w-3" strokeWidth={2.5} />
                  Archive
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
