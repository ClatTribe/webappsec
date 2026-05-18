'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Link2,
  Unlink,
  Save,
  AlertCircle,
  CheckCircle2,
  Circle,
  Trash2,
} from 'lucide-react';

interface Template {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  asset_type: string | null;
  config: Record<string, unknown>;
  tags: Record<string, unknown>;
}

interface AttachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
  status: string;
  last_scan_at: string | null;
}

interface UnattachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
}

// Detail page: shows attached targets, attach widget, editable
// config + tags, and Archive button. Config edits PATCH and propagate
// immediately via the effective_target_config_v view.

export default function TargetTemplateDetailClient({
  template,
  attached,
  unattached,
}: {
  template: Template;
  attached: AttachedTarget[];
  unattached: UnattachedTarget[];
}) {
  const router = useRouter();
  const [configText, setConfigText] = useState(
    JSON.stringify(template.config ?? {}, null, 2),
  );
  const [tagsText, setTagsText] = useState(
    JSON.stringify(template.tags ?? {}, null, 2),
  );
  const [selectedToAttach, setSelectedToAttach] = useState<Set<string>>(
    new Set(),
  );
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState<'config' | 'attach' | 'detach' | 'archive' | null>(
    null,
  );
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  );

  const filtered = unattached.filter((t) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.value.toLowerCase().includes(q)
    );
  });

  function toggle(id: string) {
    const n = new Set(selectedToAttach);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelectedToAttach(n);
  }

  async function saveConfig() {
    setSaving('config');
    setBanner(null);
    try {
      const parsedConfig = JSON.parse(configText);
      const parsedTags = JSON.parse(tagsText);
      const res = await fetch(`/api/target-templates/${template.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: parsedConfig, tags: parsedTags }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Save failed.' });
      } else {
        setBanner({
          tone: 'ok',
          text: 'Saved. Attached targets will use the new config on next scan.',
        });
        router.refresh();
      }
    } catch (e) {
      setBanner({
        tone: 'err',
        text:
          e instanceof SyntaxError
            ? 'Config or tags is not valid JSON.'
            : e instanceof Error
              ? e.message
              : String(e),
      });
    } finally {
      setSaving(null);
    }
  }

  async function attach() {
    if (selectedToAttach.size === 0) return;
    setSaving('attach');
    setBanner(null);
    try {
      const res = await fetch(
        `/api/target-templates/${template.slug}/targets`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_ids: [...selectedToAttach] }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        attached?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Attach failed.' });
      } else {
        setBanner({
          tone: 'ok',
          text: `Attached ${body.attached ?? 0} target(s).`,
        });
        setSelectedToAttach(new Set());
        router.refresh();
      }
    } finally {
      setSaving(null);
    }
  }

  async function detach(targetId: string) {
    setSaving('detach');
    setBanner(null);
    try {
      const res = await fetch(
        `/api/target-templates/${template.slug}/targets`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_ids: [targetId] }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBanner({ tone: 'err', text: body.error ?? 'Detach failed.' });
      } else {
        router.refresh();
      }
    } finally {
      setSaving(null);
    }
  }

  async function archive() {
    if (
      !window.confirm(
        `Archive template "${template.name}"? Attached targets keep their existing config snapshot but no longer inherit changes.`,
      )
    ) {
      return;
    }
    setSaving('archive');
    setBanner(null);
    try {
      const res = await fetch(`/api/target-templates/${template.slug}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ tone: 'err', text: body.error ?? 'Archive failed.' });
      } else {
        router.push('/settings/target-templates');
      }
    } finally {
      setSaving(null);
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

      {/* Config editor */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Config (JSON)
        </h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Merged with each attached target&apos;s own config — target keys win.
        </p>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={12}
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
        />

        <h2 className="mt-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Tags (JSON)
        </h2>
        <textarea
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={saveConfig}
            disabled={saving !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-1.5 text-xs font-semibold text-neutral-950 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={2.5} />
            {saving === 'config' ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={archive}
            disabled={saving !== null}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.5} />
            Archive template
          </button>
        </div>
      </section>

      {/* Attached targets */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Attached targets · {attached.length}
        </h2>
        {attached.length === 0 ? (
          <p className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-4 text-center text-sm text-neutral-500">
            No targets attached yet. Use the panel below to attach some.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {attached.map((t, i) => (
              <div
                key={t.id}
                className={`grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2.5 ${
                  i < attached.length - 1 ? 'border-b border-neutral-800/60' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-neutral-100">
                      {t.name}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
                      {t.type}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[10.5px] text-neutral-500">
                    {t.value}
                  </p>
                </div>
                <span className="text-[10.5px] text-neutral-500">
                  {t.last_scan_at
                    ? new Date(t.last_scan_at).toLocaleDateString()
                    : 'never scanned'}
                </span>
                <button
                  type="button"
                  onClick={() => detach(t.id)}
                  disabled={saving !== null}
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
      {unattached.length > 0 && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                <Link2 className="h-3 w-3" strokeWidth={2.25} />
                Attach unattached targets
              </h2>
              <p className="mt-0.5 text-[11px] text-neutral-500">
                {unattached.length} eligible target
                {unattached.length === 1 ? '' : 's'}
                {template.asset_type
                  ? ` (filtered to ${template.asset_type})`
                  : ''}
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
                disabled={saving !== null || selectedToAttach.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 disabled:opacity-50"
              >
                <Link2 className="h-3 w-3" strokeWidth={2.5} />
                Attach {selectedToAttach.size > 0 && `(${selectedToAttach.size})`}
              </button>
            </div>
          </div>

          <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/40">
            {filtered.length === 0 ? (
              <p className="p-3 text-center text-xs text-neutral-500">
                No matches.
              </p>
            ) : (
              filtered.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggle(t.id)}
                  className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-900/50 ${
                    i < filtered.length - 1 ? 'border-b border-neutral-800/40' : ''
                  } ${selectedToAttach.has(t.id) ? 'bg-cyan-500/[0.05]' : ''}`}
                >
                  {selectedToAttach.has(t.id) ? (
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-cyan-300"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <Circle
                      className="h-3.5 w-3.5 text-neutral-600"
                      strokeWidth={2}
                    />
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
    </div>
  );
}
