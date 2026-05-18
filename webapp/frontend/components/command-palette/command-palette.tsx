'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Boxes,
  ShieldAlert,
  ScanLine,
  FolderKanban,
  Home,
  Plug,
  Wrench,
  FileLock,
  MessageSquare,
  Plus,
  CornerDownLeft,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ⌘K command palette — global keyboard-driven nav across the four
// primary entities plus the static action set.
//
// Why a separate component instead of full-text search:
//   - The audience is a developer who knows where things live but
//     wants to skip the mouse. The palette is fundamentally about
//     KEYBOARD speed, not discovery.
//   - Static actions (Add asset / Go to Setup / etc.) carry their
//     weight because they cover the 30% of palette uses that aren't
//     entity lookup.
//
// Implementation:
//   - Mounted globally via app/(app)/layout.tsx.
//   - Trigger: ⌘K / Ctrl+K. Also a visible "Search" button in the
//     sidebar for users who don't know the shortcut yet.
//   - 150ms debounced fetch to /api/search?q=... while typing.
//   - Arrow keys + Enter for navigation; Esc to close.
//   - Always shows the static actions even when empty so power
//     users can hit "⌘K → Enter" for the most common action.

interface SearchResult {
  group: 'assets' | 'findings' | 'scans' | 'projects';
  id: string;
  label: string;
  sublabel?: string | null;
  href: string;
}

interface StaticAction {
  id: string;
  label: string;
  sublabel?: string;
  href: string;
  Icon: LucideIcon;
}

const STATIC_ACTIONS: StaticAction[] = [
  { id: 'nav-home', label: 'Go to Home', sublabel: 'today\'s inbox + posture', href: '/home', Icon: Home },
  { id: 'nav-assets', label: 'Go to Assets', sublabel: 'what TensorShield monitors', href: '/assets', Icon: Boxes },
  { id: 'nav-findings', label: 'Go to Findings', sublabel: 'open vulnerabilities', href: '/findings', Icon: ShieldAlert },
  { id: 'nav-compliance', label: 'Go to Compliance', sublabel: 'audit posture', href: '/compliance', Icon: FileLock },
  { id: 'nav-scans', label: 'Go to Scans', sublabel: 'scan history', href: '/scans', Icon: ScanLine },
  { id: 'nav-chat', label: 'Open Chat', sublabel: 'ask TensorShield', href: '/chat', Icon: MessageSquare },
  { id: 'nav-setup', label: 'Open Setup', sublabel: 'integrations · team · settings', href: '/setup', Icon: Wrench },
  { id: 'nav-integrations', label: 'Manage integrations', sublabel: 'GitHub · AWS · GCP · Azure · K8s', href: '/integrations', Icon: Plug },
  { id: 'add-asset', label: 'Add asset', sublabel: 'open the connect / import sheet', href: '/assets', Icon: Plus },
];

const GROUP_META: Record<SearchResult['group'], { label: string; Icon: LucideIcon }> = {
  assets: { label: 'Assets', Icon: Boxes },
  findings: { label: 'Findings', Icon: ShieldAlert },
  scans: { label: 'Scans', Icon: ScanLine },
  projects: { label: 'Projects', Icon: FolderKanban },
};

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global ⌘K / Ctrl+K listener + custom event from the sidebar
  // Search button (server-rendered tree can't share state directly).
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    const eventHandler = () => setOpen(true);
    window.addEventListener('keydown', keyHandler);
    window.addEventListener('tensorshield:open-palette', eventHandler);
    return () => {
      window.removeEventListener('keydown', keyHandler);
      window.removeEventListener('tensorshield:open-palette', eventHandler);
    };
  }, [open]);

  // Reset when closing
  useEffect(() => {
    if (!open) {
      setQ('');
      setResults([]);
      setSelectedIdx(0);
    } else {
      // Focus input on next paint
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (!res.ok) {
          setResults([]);
          return;
        }
        const body = (await res.json()) as { results?: SearchResult[] };
        setResults(body.results ?? []);
        setSelectedIdx(0);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  // Flattened action list — static actions filtered by the query plus
  // the live search results below. This is what's keyboard-navigable.
  const filteredStatic = useMemo(() => {
    const qLow = q.trim().toLowerCase();
    if (qLow.length === 0) return STATIC_ACTIONS;
    return STATIC_ACTIONS.filter((a) =>
      `${a.label} ${a.sublabel ?? ''}`.toLowerCase().includes(qLow),
    );
  }, [q]);

  // Flatten into a single array we can index with selectedIdx. Order:
  // static actions (always on top so common nav is fast), then live
  // results grouped by entity.
  const flat = useMemo(() => {
    const list: Array<
      | { kind: 'action'; action: StaticAction }
      | { kind: 'result'; result: SearchResult }
    > = [];
    for (const a of filteredStatic) list.push({ kind: 'action', action: a });
    for (const r of results) list.push({ kind: 'result', result: r });
    return list;
  }, [filteredStatic, results]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const sel = flat[selectedIdx];
        if (!sel) return;
        const href = sel.kind === 'action' ? sel.action.href : sel.result.href;
        setOpen(false);
        router.push(href);
      }
    },
    [flat, selectedIdx, router],
  );

  // Group live results by entity for visual rendering.
  const byGroup: Record<SearchResult['group'], SearchResult[]> = {
    assets: [],
    findings: [],
    scans: [],
    projects: [],
  };
  for (const r of results) byGroup[r.group].push(r);

  if (!open) return null;

  // Index counter for keyboard selection bookkeeping
  let runningIdx = 0;
  const actionsStartIdx = runningIdx;
  runningIdx += filteredStatic.length;
  const groupIndices: Record<SearchResult['group'], number> = {
    assets: -1,
    findings: -1,
    scans: -1,
    projects: -1,
  };
  for (const g of ['assets', 'findings', 'scans', 'projects'] as const) {
    if (byGroup[g].length > 0) {
      groupIndices[g] = runningIdx;
      runningIdx += byGroup[g].length;
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-20 w-full max-w-xl overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
          <Search className="h-4 w-4 flex-shrink-0 text-neutral-500" strokeWidth={2.25} />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search assets, findings, scans, or jump anywhere…"
            className="flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          {loading && <span className="text-[10.5px] text-neutral-500">searching…</span>}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-96 overflow-y-auto py-2">
          {flat.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              {q.trim().length < 2
                ? 'Type to search assets, findings, scans, projects.'
                : 'No matches.'}
            </p>
          )}

          {filteredStatic.length > 0 && (
            <Section title="Jump to">
              {filteredStatic.map((a, i) => (
                <Row
                  key={a.id}
                  Icon={a.Icon}
                  label={a.label}
                  sublabel={a.sublabel}
                  selected={selectedIdx === actionsStartIdx + i}
                  onMouseEnter={() => setSelectedIdx(actionsStartIdx + i)}
                  onClick={() => {
                    setOpen(false);
                    router.push(a.href);
                  }}
                />
              ))}
            </Section>
          )}

          {(['assets', 'findings', 'scans', 'projects'] as const).map((g) => {
            const items = byGroup[g];
            if (items.length === 0) return null;
            const Icon = GROUP_META[g].Icon;
            return (
              <Section key={g} title={GROUP_META[g].label} TitleIcon={Icon}>
                {items.map((r, i) => (
                  <Row
                    key={r.id}
                    Icon={Icon}
                    label={r.label}
                    sublabel={r.sublabel ?? undefined}
                    selected={selectedIdx === groupIndices[g] + i}
                    onMouseEnter={() => setSelectedIdx(groupIndices[g] + i)}
                    onClick={() => {
                      setOpen(false);
                      router.push(r.href);
                    }}
                  />
                ))}
              </Section>
            );
          })}
        </div>

        {/* Footer hint row */}
        <div className="flex items-center gap-4 border-t border-neutral-800 px-4 py-2 text-[10px] text-neutral-500">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[9px]">↑</kbd>
            <kbd className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[9px]">↓</kbd>
            navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex items-center rounded bg-neutral-900 px-1 py-0.5 font-mono text-[9px]">
              <CornerDownLeft className="h-2.5 w-2.5" />
            </kbd>
            select
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[9px]">Esc</kbd>
            close
          </span>
          <span className="ml-auto">
            ⌘K from anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  TitleIcon,
  children,
}: {
  title: string;
  TitleIcon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-[9.5px] uppercase tracking-wider text-neutral-500">
        {TitleIcon && <TitleIcon className="h-3 w-3" strokeWidth={2.25} />}
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  Icon,
  label,
  sublabel,
  selected,
  onClick,
  onMouseEnter,
}: {
  Icon: LucideIcon;
  label: string;
  sublabel?: string;
  selected: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`grid w-full grid-cols-[auto_1fr] items-center gap-3 px-4 py-2 text-left transition-colors ${
        selected ? 'bg-cyan-500/10' : 'hover:bg-neutral-900/60'
      }`}
    >
      <Icon
        className={`h-3.5 w-3.5 ${selected ? 'text-cyan-300' : 'text-neutral-500'}`}
        strokeWidth={2.25}
      />
      <div className="min-w-0">
        <div className={`truncate text-sm ${selected ? 'text-neutral-50' : 'text-neutral-200'}`}>
          {label}
        </div>
        {sublabel && (
          <div className="mt-0.5 truncate text-[10.5px] text-neutral-500">
            {sublabel}
          </div>
        )}
      </div>
    </button>
  );
}
