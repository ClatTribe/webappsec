'use client';

// AISecurityEngineerUXRoadmap.md §1.2 + §13.1 — the in-app chat surface.
//
// Subscribes to org-scoped agent_messages realtime channel (filtered by
// thread_id so we don't see other threads' traffic). On insert: append.
// Posting a user-role message goes through a plain RLS-allowed insert
// (agent_messages_user_insert policy from migration 042). The BEFORE
// INSERT trigger denormalises org_id from the thread; the AFTER INSERT
// trigger bumps thread.last_message_at.

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { AgentMessage } from '@/lib/supabase/types';
import { AgentMessageView } from './agent-message';
import { Send, Sparkles } from 'lucide-react';

interface ChatPanelProps {
  threadId: string;
  orgId: string;
  userId: string;
  initialMessages: AgentMessage[];
}

export function ChatPanel({ threadId, orgId, userId, initialMessages }: ChatPanelProps) {
  const supabase = createClient();
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [posting, setPosting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Realtime: subscribe to inserts on agent_messages for this thread.
  // The realtime publication is org-scoped via RLS so we never see
  // other orgs' rows even if the filter were wider.
  useEffect(() => {
    const channel = supabase
      .channel(`agent_messages:thread:${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const m = payload.new as unknown as AgentMessage;
          setMessages((prev) => {
            // Idempotent — if we already rendered this id (e.g. our own
            // optimistic insert), skip.
            if (prev.some((p) => p.id === m.id)) return prev;
            return [...prev, m];
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, threadId]);

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  async function postUserMessage() {
    const text = input.trim();
    if (!text || posting) return;
    setPosting(true);
    setInput('');
    const blocks = [{ type: 'text', markdown: text }];
    const { error } = await supabase.from('agent_messages').insert({
      thread_id: threadId,
      role: 'user',
      blocks,
      citations: [],
    } as never);
    if (error) {
      // Surface inline; restore the input so the user can retry.
      setInput(text);
      console.error('agent_messages insert failed', error);
      setPosting(false);
      return;
    }
    setPosting(false);

    // Fire-and-forget — process the user message via the NL triage handler.
    // If an intent is recognised, the agent posts a confirmation message
    // (which arrives via realtime). If not, the agent posts a polite
    // fallback. Either way, no client-side branching needed.
    void fetch('/api/chat/process-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, text }),
    }).catch((err) => {
      // Best-effort. The user message is already in the thread; a missed
      // intent classification is recoverable (user can use buttons).
      console.error('process-message failed', err);
    });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800/60 bg-neutral-950/40 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-neutral-100">TensorShield</h1>
            <p className="text-xs text-neutral-400">Your AI security engineer</p>
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-6 py-6"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((m) => <AgentMessageView key={m.id} message={m} userId={userId} />)
        )}
      </div>

      <footer className="border-t border-neutral-800/60 bg-neutral-950/40 px-6 py-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            postUserMessage();
          }}
          className="flex items-end gap-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                postUserMessage();
              }
            }}
            placeholder="Ask TensorShield anything about your scans, findings, or assets…"
            rows={1}
            className="flex-1 resize-none rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-neutral-600"
          />
          <button
            type="submit"
            disabled={!input.trim() || posting}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20 transition-opacity disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        <p className="mt-2 text-xs text-neutral-500">
          TensorShield is scoped to your workspace. Findings, scans, and compliance evidence stay
          in workspace{' '}
          <code className="font-mono text-neutral-400">{orgId.slice(0, 8)}…</code>.
        </p>
      </footer>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center py-20 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20">
        <Sparkles className="h-7 w-7 text-cyan-400" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-neutral-100">Welcome to your security workspace</h2>
      <p className="max-w-md text-sm text-neutral-400">
        Register an asset (repo, web app, domain) and TensorShield will start scanning. Findings stream into this chat as
        they&apos;re discovered. Ask follow-up questions, dismiss false positives, or request fixes — all from
        here.
      </p>
    </div>
  );
}
