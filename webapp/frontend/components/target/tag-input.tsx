'use client';

import { useState, type KeyboardEvent } from 'react';
import { X, Plus } from 'lucide-react';

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional inline validator. Return an error message to reject the entry,
   *  or null to accept it. Receives the trimmed candidate string. */
  validate?: (entry: string) => string | null;
  /** Maximum number of chips. Adds beyond this are silently rejected. */
  max?: number;
  /** When the user types this character, the current input is committed. */
  delimiter?: string;
  /** Visual accent on the chips. Matches the per-target-type colour. */
  accent?: 'cyan' | 'amber' | 'emerald' | 'violet' | 'sky';
}

const ACCENT: Record<NonNullable<Props['accent']>, string> = {
  cyan: 'bg-cyan-500/15 text-cyan-200 ring-cyan-500/30',
  amber: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  emerald: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
  violet: 'bg-violet-500/15 text-violet-200 ring-violet-500/30',
  sky: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
};

/**
 * Chip-based input for free-form list fields. Replaces comma-separated text
 * inputs (which are universally hated UX) for `crawl_seeds`, `path_excludes`,
 * etc. on the target form.
 *
 * Interaction:
 *   - Type → press Enter or Comma → chip created
 *   - Click ✕ on a chip → removed
 *   - Backspace on empty input → removes the last chip (Gmail/Linear pattern)
 *   - Paste a comma-separated string → split + each becomes a chip
 */
export default function TagInput({
  value,
  onChange,
  placeholder,
  validate,
  max = 50,
  delimiter = ',',
  accent = 'cyan',
}: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string): void => {
    const cleaned = raw.trim();
    if (!cleaned) return;
    if (value.includes(cleaned)) {
      setError(null);
      setDraft('');
      return;
    }
    if (value.length >= max) {
      setError(`At most ${max} entries.`);
      return;
    }
    if (validate) {
      const err = validate(cleaned);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    onChange([...value, cleaned]);
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === delimiter) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text');
    if (text.includes(delimiter) || text.includes('\n')) {
      e.preventDefault();
      const parts = text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const next = [...value];
      for (const p of parts) {
        if (next.length >= max) break;
        if (!next.includes(p)) {
          if (validate && validate(p)) continue;
          next.push(p);
        }
      }
      onChange(next);
      setDraft('');
    }
  };

  const accentClass = ACCENT[accent];

  return (
    <div>
      <div className="group flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 px-2 py-1.5 transition-colors focus-within:border-cyan-500 focus-within:ring-1 focus-within:ring-cyan-500/30">
        {value.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[12px] ring-1 ${accentClass}`}
          >
            <span className="max-w-[26ch] truncate">{tag}</span>
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="rounded p-0.5 opacity-60 hover:opacity-100 hover:bg-white/10"
              aria-label={`Remove ${tag}`}
            >
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          placeholder={value.length === 0 ? placeholder : 'Add another…'}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={() => commit(draft)}
          className="min-w-[10ch] flex-1 bg-transparent px-1.5 py-1 font-mono text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />
        {draft.trim() && (
          <button
            type="button"
            onClick={() => commit(draft)}
            className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-cyan-300"
            aria-label="Add"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
      {error && (
        <div className="mt-1 text-[11px] text-red-300">{error}</div>
      )}
      {!error && value.length === 0 && placeholder && (
        <div className="mt-1 text-[11px] text-neutral-500">
          Press <kbd className="rounded bg-neutral-800 px-1 font-mono">Enter</kbd> or{' '}
          <kbd className="rounded bg-neutral-800 px-1 font-mono">,</kbd> to add. Paste a
          comma-separated list to add multiple at once.
        </div>
      )}
    </div>
  );
}
