// AISecurityEngineerUXRoadmap.md §3 Phase A — chat as the primary
// interaction surface for the active org. Server-component loader:
//
//   1. Resolve the active org (RLS via JWT will scope every read).
//   2. Find-or-create the primary thread for that org (matches
//      worker_get_or_create_primary_thread / the findings-to-chat
//      trigger from migration 043 so both code paths converge).
//   3. Load the most recent messages.
//   4. Hand off to the client component for realtime + posting.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ChatPanel } from '@/components/chat/chat-panel';
import type { AgentMessage, AgentThread } from '@/lib/supabase/types';

const INITIAL_MESSAGE_LIMIT = 100;

export const metadata = {
  title: 'TensorShield — Chat',
};

export default async function ChatPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // The JWT hook injects org_id; RLS scopes everything that follows.
  // Find-or-create the primary thread. We do this as a regular insert
  // (RLS-allowed) rather than calling the service-role worker helper.
  let { data: threads } = await supabase
    .from('agent_threads')
    .select('*')
    .eq('archived', false)
    .filter('context->>kind', 'eq', 'primary')
    .limit(1);
  let thread = threads?.[0] as AgentThread | undefined;

  if (!thread) {
    const { data: created } = await supabase
      .from('agent_threads')
      .insert({
        title: 'TensorShield',
        context: { kind: 'primary' },
      } as never)
      .select('*')
      .single();
    thread = (created as unknown as AgentThread) ?? undefined;
  }

  const messages: AgentMessage[] = [];
  if (thread) {
    const { data: msgs } = await supabase
      .from('agent_messages')
      .select('*')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true })
      .limit(INITIAL_MESSAGE_LIMIT);
    if (msgs) {
      messages.push(...((msgs as unknown) as AgentMessage[]));
    }
  }

  if (!thread) {
    // RLS denied the insert — means user has no org membership. Send
    // them somewhere they can fix that (today: dashboard with empty
    // state; later: org-onboarding flow).
    redirect('/dashboard');
  }

  return (
    <div className="flex h-[calc(100vh-1rem)] flex-col">
      <ChatPanel
        threadId={thread.id}
        orgId={thread.org_id}
        userId={user.id}
        initialMessages={messages}
      />
    </div>
  );
}
