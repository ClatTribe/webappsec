'use client';

// Renders one AgentMessage. Delegates per-block rendering to AgentBlockView.
// Unknown block types fall through to collapsed JSON so adding a new
// block kind doesn't require a frontend deploy.

import { useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, User } from 'lucide-react';
import type { AgentBlock, AgentMessage, AgentSuggestion } from '@/lib/supabase/types';

interface Props {
  message: AgentMessage;
  userId: string;
}

export function AgentMessageView({ message, userId }: Props) {
  void userId;
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
      data-testid="agent-message"
      data-role={message.role}
    >
      <div className="flex-shrink-0 pt-1">
        {isUser ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-700 text-xs text-neutral-200">
            <User className="h-3.5 w-3.5" />
          </div>
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 shadow-md shadow-cyan-500/10">
            <Sparkles className="h-3.5 w-3.5 text-white" />
          </div>
        )}
      </div>

      <div className={`max-w-[80%] space-y-2 ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-3 text-sm ${
            isUser
              ? 'bg-cyan-500/20 text-neutral-100'
              : isSystem
              ? 'bg-amber-500/10 text-amber-200'
              : 'bg-neutral-900/60 text-neutral-100'
          }`}
        >
          <div className="space-y-3">
            {(message.blocks ?? []).map((block, idx) => (
              <AgentBlockView key={idx} block={block} />
            ))}
          </div>
        </div>

        {message.suggestions && message.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.suggestions.map((s, idx) => (
              <SuggestionButton key={idx} suggestion={s} threadId={message.thread_id} />
            ))}
          </div>
        )}

        {message.confidence != null && (
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            Confidence: {(message.confidence * 100).toFixed(0)}%
          </div>
        )}

        <div className="text-[10px] text-neutral-600">
          {new Date(message.created_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
    </div>
  );
}

function AgentBlockView({ block }: { block: AgentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.markdown}</ReactMarkdown>
        </div>
      );
    case 'finding_ref':
      return (
        <Link
          href={`/findings/${block.finding_id}`}
          className="inline-flex items-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-300 transition-colors hover:bg-cyan-500/20"
        >
          🔍 View finding details
        </Link>
      );
    case 'scan_ref':
      return (
        <Link
          href={`/scans/${block.scan_id}`}
          className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          🛰  Open scan
        </Link>
      );
    case 'asset_ref':
      return (
        <Link
          href={`/targets/${block.target_id}`}
          className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          📦 Open asset
        </Link>
      );
    case 'pr_ref':
      return (
        <a
          href={block.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20"
        >
          ↗ {block.title} ({block.status})
        </a>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <code className={`language-${block.language}`}>{block.content}</code>
        </pre>
      );
    case 'diff':
      return (
        <div className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
          <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 font-mono text-[10px] text-neutral-400">
            {block.file}
          </div>
          <pre className="overflow-x-auto p-3 text-xs">
            <code>{block.after}</code>
          </pre>
        </div>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-xs">
            <thead className="border-b border-neutral-800 bg-neutral-900/60">
              <tr>
                {block.columns.map((c, i) => (
                  <th key={i} className="px-3 py-2 text-left font-medium text-neutral-400">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-neutral-800/60 last:border-0">
                  {(row as unknown[]).map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-neutral-300">
                      {String(cell ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption && (
            <div className="border-t border-neutral-800/60 bg-neutral-900/40 px-3 py-1.5 text-[10px] text-neutral-500">
              {block.caption}
            </div>
          )}
        </div>
      );
    case 'screenshot':
      return (
        <figure>
          <img src={block.url} alt={block.alt} className="rounded-md border border-neutral-800" />
          {block.caption && (
            <figcaption className="mt-1 text-[10px] text-neutral-500">{block.caption}</figcaption>
          )}
        </figure>
      );
    case 'timeline':
      return (
        <ol className="space-y-1.5 border-l-2 border-neutral-800 pl-4 text-xs">
          {block.events.map((e, i) => (
            <li key={i} className="relative">
              <div className="absolute -left-[19px] top-1.5 h-2 w-2 rounded-full bg-cyan-500" />
              <div className="text-neutral-400">{new Date(e.at).toLocaleString()}</div>
              <div className="text-neutral-200">{e.label}</div>
            </li>
          ))}
        </ol>
      );
    case 'chart':
      // Charts: placeholder rendering; first concrete chart block lands when
      // the agent emits one (e.g. SOC2-readiness delta in Phase C).
      return (
        <div className="rounded-md border border-dashed border-neutral-700 px-3 py-4 text-center text-xs text-neutral-500">
          [{block.kind} chart — renderer pending]
          {block.caption && <div className="mt-1 text-neutral-400">{block.caption}</div>}
        </div>
      );
    default: {
      const unknown = block as { type: string };
      return (
        <details className="rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <summary className="cursor-pointer text-xs text-neutral-500">
            Unrenderable block ({unknown.type})
          </summary>
          <pre className="mt-2 overflow-x-auto text-[10px] text-neutral-400">
            {JSON.stringify(block, null, 2)}
          </pre>
        </details>
      );
    }
  }
}

function SuggestionButton({
  suggestion,
  threadId,
}: {
  suggestion: AgentSuggestion;
  threadId: string;
}) {
  // Phase B — wire dismiss / suggest_fix / mark_real to the triage-action
  // API. open_finding is a plain navigation. Unknown actions fall through
  // to a CustomEvent so future handlers can be added without modifying
  // this file.
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'ok' | 'err' | null>(null);

  async function onClick() {
    if (busy) return;
    const findingId =
      typeof suggestion.payload?.finding_id === 'string'
        ? suggestion.payload.finding_id
        : null;

    if (suggestion.action === 'open_finding' && findingId) {
      window.location.href = `/findings/${findingId}`;
      return;
    }

    if (
      (suggestion.action === 'dismiss' ||
        suggestion.action === 'mark_real' ||
        suggestion.action === 'suggest_fix') &&
      findingId
    ) {
      // Optional inline reason for dismiss — keeps the suppression-rule
      // path useful. For Phase B v1 we use a native prompt to avoid
      // hauling in a modal; richer UX (textarea overlay) can land later.
      let reason: string | undefined;
      if (suggestion.action === 'dismiss') {
        const r = window.prompt(
          'Why are you dismissing this finding? (optional — helps the agent learn your suppression rules)',
          '',
        );
        // User hit cancel — don't proceed
        if (r === null) return;
        reason = r.trim() || undefined;
      }

      setBusy(true);
      try {
        const resp = await fetch('/api/chat/triage-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: suggestion.action,
            finding_id: findingId,
            thread_id: threadId,
            reason,
          }),
        });
        if (resp.ok) {
          setDone('ok');
        } else {
          setDone('err');
          // Best-effort error surfacing — the realtime stream will
          // bring an updated message if one was posted.
          console.error('triage-action failed', resp.status, await resp.text());
        }
      } catch (e) {
        setDone('err');
        console.error('triage-action error', e);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Unknown — emit for any external listener.
    window.dispatchEvent(
      new CustomEvent('strix:suggestion', { detail: suggestion }),
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || done === 'ok'}
      className={`rounded-md border px-3 py-1 text-xs transition-colors ${
        done === 'ok'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : done === 'err'
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
          : 'border-neutral-700 bg-neutral-800/60 text-neutral-200 hover:bg-neutral-800'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {busy ? '…' : done === 'ok' ? '✓ Done' : done === 'err' ? '! Retry' : suggestion.label}
    </button>
  );
}
