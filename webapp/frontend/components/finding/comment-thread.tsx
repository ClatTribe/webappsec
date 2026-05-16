'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Loader2, User } from 'lucide-react';

// Tier I #6 — append-only comment thread on a finding card.
//
// Renders the existing comments + a single-line composer. Soft-deleted
// rows are surfaced as "[redacted]" placeholders so the audit pack
// stays complete (SOC 2 #CC4.1 — change log integrity).
//
// We deliberately don't subscribe to realtime updates yet — the use-
// case is "drop a note while triaging" rather than "live chat"; one
// fetch on mount + optimistic insert covers it. We'll add a Supabase
// realtime channel here when ticket-volume grows past a single triager.

interface CommentRow {
  id: string;
  finding_id: string;
  user_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface Props {
  findingId: string;
}

export default function CommentThread({ findingId }: Props) {
  const [comments, setComments] = useState<CommentRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/findings/${findingId}/comments`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setErr(json?.error ?? `failed (${res.status})`);
          setComments([]);
          return;
        }
        setComments((json.comments ?? []) as CommentRow[]);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'failed to load comments');
        setComments([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [findingId]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/findings/${findingId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setComments((prev) => [...(prev ?? []), json.comment as CommentRow]);
      setDraft('');
      // Keep the composer focused so threading is fluid.
      textRef.current?.focus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setPosting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <section className="space-y-2.5 rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-neutral-400" strokeWidth={2.25} />
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Discussion
        </h4>
        {comments && (
          <span className="text-[10.5px] text-neutral-500">
            {comments.length} comment{comments.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {comments === null ? (
        <div className="text-[11px] text-neutral-500">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} /> Loading…
        </div>
      ) : comments.length === 0 ? (
        <div className="text-[11px] text-neutral-500">
          No comments yet. Drop the first one to leave a triage note for your team.
        </div>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li
              key={c.id}
              className={`rounded-md border px-3 py-2 ${
                c.deleted_at
                  ? 'border-neutral-800/60 bg-neutral-950/30 text-neutral-500'
                  : 'border-neutral-800/80 bg-neutral-950/40'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2 pb-1">
                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-cyan-200">
                  <User className="h-2.5 w-2.5" strokeWidth={2.5} />
                  {c.author_name ?? c.user_id.slice(0, 8)}
                </span>
                <span
                  className="text-[10px] text-neutral-600"
                  title={new Date(c.created_at).toLocaleString()}
                >
                  {relativeTime(c.created_at)}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words text-[12px] text-neutral-200">
                {c.body}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Leave a triage note…  (⌘/Ctrl + Enter to post)"
          rows={2}
          maxLength={16_384}
          className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600 focus:border-cyan-500/40 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-neutral-600">
            {draft.length > 0 && `${draft.length} / 16,384`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={posting || draft.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {posting ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
            ) : (
              <Send className="h-3 w-3" strokeWidth={2.25} />
            )}
            Post
          </button>
        </div>
        {err && <div className="text-[10.5px] text-rose-300">{err}</div>}
      </div>
    </section>
  );
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
