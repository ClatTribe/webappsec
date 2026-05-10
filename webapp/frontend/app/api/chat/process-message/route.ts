// AISecurityEngineerUXRoadmap.md §4 Phase B — NL triage handler.
//
// When a user posts a chat message, this endpoint runs a lightweight
// intent classifier over it. Recognised intents get acted upon and
// produce an agent-reply message in the same thread. Unrecognised
// intents fall through to a polite "I don't understand yet" reply
// pointing the user at the suggestion buttons.
//
// V1 patterns (regex-based; no LLM dependency for now):
//
//   • "dismiss [the/all] {severity}(s)" — bulk-dismiss all currently-open
//     findings at that severity for the active org. severity ∈
//     {critical, high, medium, low, info}.
//
//   • "show [me] open" / "what's open" / "any new" / "any open" —
//     summarise the org's open findings, grouped by severity.
//
// Anything else gets a fallback agent message. The richer LLM-powered
// classifier lands in a follow-up that runs in the worker (so it can
// share inference plumbing + budget tracking with the scan agent).
//
// All operations are RLS-scoped via the caller's JWT. Bulk writes go
// through the user-auth client so RLS denies cross-org mutations even
// if the classifier mis-routes.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  thread_id: z.string().uuid(),
  text: z.string().min(1).max(4000),
});

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEV_EMOJI: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '🔵',
};

interface DismissIntent {
  kind: 'dismiss_by_severity';
  severity: Severity;
}
interface ShowOpenIntent {
  kind: 'show_open';
}
interface UnknownIntent {
  kind: 'unknown';
}
type Intent = DismissIntent | ShowOpenIntent | UnknownIntent;

// V1 classifier. Deliberately narrow — false positives here would be
// destructive (bulk-dismissing the wrong things). Patterns require a
// recognisable verb + a recognisable scope; otherwise fall through.
function classify(text: string): Intent {
  const t = text.toLowerCase().trim();

  // dismiss the lows / dismiss all lows / dismiss lows / dismiss the low ones
  const sevPattern = /\bdismiss\b.*\b(critical|high|medium|low|info)s?\b/;
  const sevMatch = t.match(sevPattern);
  if (sevMatch) {
    return { kind: 'dismiss_by_severity', severity: sevMatch[1] as Severity };
  }

  // show open / what's open / any new / list open
  if (
    /\b(show|list|what's|whats|any|count)\b.*\bopen\b/.test(t) ||
    /\bany\s+new\b/.test(t) ||
    /\bwhat\s+do\s+i\s+have\b/.test(t)
  ) {
    return { kind: 'show_open' };
  }

  return { kind: 'unknown' };
}

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { thread_id, text } = parsed.data;

  // Confirm thread belongs to caller's org via RLS.
  const { data: threadRow } = await supabase
    .from('agent_threads')
    .select('id, org_id')
    .eq('id', thread_id)
    .single();
  const thread = threadRow as unknown as { id: string; org_id: string } | null;
  if (!thread) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404 });
  }

  const intent = classify(text);
  const admin = createAdminClient();

  if (intent.kind === 'dismiss_by_severity') {
    return await handleDismissBySeverity(
      supabase,
      admin,
      user.id,
      thread,
      intent.severity,
      text,
    );
  }

  if (intent.kind === 'show_open') {
    return await handleShowOpen(supabase, admin, thread);
  }

  // Fallback — polite acknowledgement.
  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown: `I'm still learning natural-language triage. For now I understand:\n\n- **"dismiss the lows"** (or highs / mediums / criticals) — bulk-dismiss findings at that severity.\n- **"what's open"** — summarise current open findings.\n\nFor anything else, the action buttons under each finding card are wired up — give those a try.`,
      },
    ],
    citations: [],
  } as never);

  return NextResponse.json({ ok: true, intent: 'unknown' });
}

async function handleDismissBySeverity(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  thread: { id: string; org_id: string },
  severity: Severity,
  originalText: string,
) {
  // Find all open findings at this severity in the caller's org (RLS-scoped).
  const { data: findingsData, error: selErr } = await supabase
    .from('findings')
    .select('id, title, fingerprint')
    .eq('status', 'open')
    .eq('severity', severity);

  if (selErr) {
    return NextResponse.json({ error: `select failed: ${selErr.message}` }, { status: 500 });
  }
  const findings = (findingsData ?? []) as unknown as {
    id: string;
    title: string | null;
    fingerprint: string | null;
  }[];

  if (findings.length === 0) {
    await admin.from('agent_messages').insert({
      thread_id: thread.id,
      role: 'agent',
      blocks: [
        {
          type: 'text',
          markdown: `${SEV_EMOJI[severity]} No open **${severity}** findings to dismiss right now. You're clean.`,
        },
      ],
      citations: [],
    } as never);
    return NextResponse.json({ ok: true, intent: 'dismiss_by_severity', dismissed: 0 });
  }

  // Bulk update — RLS-scoped via the user-auth client.
  const findingIds = findings.map((f) => f.id);
  const { error: updErr } = await supabase
    .from('findings')
    .update({
      status: 'false_positive',
      triaged_by: userId,
      triaged_at: new Date().toISOString(),
    } as never)
    .in('id', findingIds);

  if (updErr) {
    return NextResponse.json({ error: `update failed: ${updErr.message}` }, { status: 500 });
  }

  // Record one episode per dismissed finding so the suppression-rule
  // learner sees them. Use admin to skip per-row RLS check cost — the
  // findings_ids array was already org-validated by RLS in the select.
  const episodeRows = findings.map((f) => ({
    org_id: thread.org_id,
    thread_id: thread.id,
    user_id: userId,
    agent_action: 'finding_dismissed',
    payload: {
      finding_id: f.id,
      finding_title: f.title,
      finding_fingerprint: f.fingerprint,
      previous_status: 'open',
      new_status: 'false_positive',
      bulk_command: originalText,
    },
    rationale: `Bulk dismiss via chat: "${originalText}"`,
  }));
  await admin.from('agent_memory_episodes').insert(episodeRows as never);

  // Confirmation message — listing titles so the user can spot misclassification.
  const titleList = findings
    .slice(0, 12)
    .map((f) => `- ${f.title ?? '(untitled)'}`)
    .join('\n');
  const moreLine = findings.length > 12 ? `\n\n_…and ${findings.length - 12} more._` : '';

  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown: `${SEV_EMOJI[severity]} **Dismissed ${findings.length} ${severity} finding${findings.length === 1 ? '' : 's'}.**\n\n${titleList}${moreLine}\n\nIf I caught one that shouldn't have been dismissed, click "Mark real" on its card or tell me and I'll revert.`,
      },
    ],
    citations: findings.slice(0, 24).map((f) => ({
      kind: 'finding',
      id: f.id,
      label: f.title ?? '',
    })),
    acted_on: findings.map((f) => ({
      kind: 'finding_dismissed',
      target: f.id,
      at: new Date().toISOString(),
      payload: { new_status: 'false_positive' },
    })),
  } as never);

  return NextResponse.json({
    ok: true,
    intent: 'dismiss_by_severity',
    severity,
    dismissed: findings.length,
  });
}

async function handleShowOpen(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  thread: { id: string; org_id: string },
) {
  const { data: findingsData } = await supabase
    .from('findings')
    .select('severity, target_id, title')
    .eq('status', 'open');
  const findings = (findingsData ?? []) as unknown as {
    severity: Severity | null;
    target_id: string | null;
    title: string | null;
  }[];

  const counts: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  for (const f of findings) {
    if (f.severity && f.severity in counts) counts[f.severity]++;
  }

  const total = findings.length;
  if (total === 0) {
    await admin.from('agent_messages').insert({
      thread_id: thread.id,
      role: 'agent',
      blocks: [
        {
          type: 'text',
          markdown: `🟢 Nothing open right now. Everything triaged or fixed.`,
        },
      ],
      citations: [],
    } as never);
    return NextResponse.json({ ok: true, intent: 'show_open', total: 0 });
  }

  const sevLines = (Object.keys(counts) as Severity[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${SEV_EMOJI[s]} **${counts[s]}** ${s}`)
    .join(' · ');

  // Plus a short "top 3 critical/high" callout.
  const top = findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 3)
    .map((f) => `- ${f.title ?? '(untitled)'}`)
    .join('\n');
  const topBlock = top ? `\n\n**Top of the list:**\n${top}` : '';

  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown: `${total} open ${total === 1 ? 'finding' : 'findings'} across your registered assets — ${sevLines}.${topBlock}`,
      },
    ],
    citations: [],
  } as never);

  return NextResponse.json({ ok: true, intent: 'show_open', total, counts });
}
