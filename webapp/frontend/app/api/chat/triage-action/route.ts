// AISecurityEngineerUXRoadmap.md §4 Phase B — triage as conversation.
//
// The chat surface emits suggestion buttons under each finding-driven
// agent message (Dismiss / Suggest fix / See details — see migration
// 043's findings_post_to_chat trigger). This endpoint is what those
// buttons POST to.
//
// Three actions for v1:
//
//   • dismiss       — sets findings.status = 'false_positive',
//                     records an agent_memory_episode, posts an agent
//                     confirmation chat message into the same thread.
//   • mark_real     — sets findings.status = 'triaged_real' (the
//                     "actually it's real" reverse-action).
//   • suggest_fix   — stub for the LLM-narrated fix-suggestion that
//                     will land with engine Phase 12 / wrapper Phase E.
//                     For now: records an episode and posts a chat
//                     message saying "I'll have a fix draft for you
//                     shortly" — wires the UX without the inference.
//
// All actions are RLS-scoped: the user can only act on findings their
// JWT's org_id grants them access to.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  action: z.enum(['dismiss', 'mark_real', 'suggest_fix']),
  finding_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

const SEV_EMOJI: Record<string, string> = {
  critical: '🛑',
  high:     '🔴',
  medium:   '🟠',
  low:      '🟡',
  info:     '🔵',
};

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
  const { action, finding_id, thread_id, reason } = parsed.data;

  // Load the finding to confirm it exists in the caller's org. RLS does
  // the actual policing — if the row's org_id doesn't match the caller's,
  // the select returns no row.
  const { data: findingRow, error: findingErr } = await supabase
    .from('findings')
    .select('id, org_id, title, severity, status, target_id, fingerprint')
    .eq('id', finding_id)
    .single();

  if (findingErr || !findingRow) {
    return NextResponse.json({ error: 'finding not found' }, { status: 404 });
  }
  const finding = findingRow as unknown as {
    id: string;
    org_id: string;
    title: string | null;
    severity: string | null;
    status: string;
    target_id: string | null;
    fingerprint: string | null;
  };

  // Confirm the thread belongs to the same org so we don't post the
  // confirmation message into someone else's thread.
  const { data: threadRow } = await supabase
    .from('agent_threads')
    .select('id, org_id')
    .eq('id', thread_id)
    .single();
  const thread = threadRow as unknown as { id: string; org_id: string } | null;
  if (!thread || thread.org_id !== finding.org_id) {
    return NextResponse.json({ error: 'thread/finding org mismatch' }, { status: 400 });
  }

  // Compose action results.
  let newStatus: string | null = null;
  let episodeAction: string = '';
  let confirmationText: string = '';

  switch (action) {
    case 'dismiss':
      newStatus = 'false_positive';
      episodeAction = 'finding_dismissed';
      confirmationText = `Dismissed — marked as false positive.${
        reason ? `\n\n> ${reason}` : ''
      }\n\nI've recorded this in the org's suppression history. If this fingerprint shows up again I'll flag it but with the dismissed-before context attached.`;
      break;
    case 'mark_real':
      newStatus = 'triaged_real';
      episodeAction = 'finding_marked_real';
      confirmationText = `Confirmed — marked as triaged_real.${
        reason ? `\n\n> ${reason}` : ''
      }`;
      break;
    case 'suggest_fix':
      // No status change yet — this is a placeholder for the engine
      // Phase 12 / wrapper Phase E fix-suggestion path. Records intent
      // so when the fix-suggest worker runs it knows what to pick up.
      newStatus = null;
      episodeAction = 'fix_suggestion_requested';
      confirmationText = `On it. I'll look at this and have a draft fix shortly.\n\n_(Fix-suggestion landing with engine Phase 12 — for now I've queued the request.)_`;
      break;
  }

  // Apply status change if any.
  if (newStatus) {
    const { error: updErr } = await supabase
      .from('findings')
      .update({
        status: newStatus,
        triaged_by: user.id,
        triaged_at: new Date().toISOString(),
      } as never)
      .eq('id', finding.id);
    if (updErr) {
      return NextResponse.json(
        { error: `update failed: ${updErr.message}` },
        { status: 500 },
      );
    }
  }

  // Record episode (RLS-scoped via the agent_memory_episodes_org_insert
  // policy from migration 041). The action handler's rationale is the
  // user-supplied reason, captured for the suppression-rule learning
  // path in a later PR.
  await supabase.from('agent_memory_episodes').insert({
    thread_id,
    user_id: user.id,
    agent_action: episodeAction,
    payload: {
      finding_id: finding.id,
      finding_title: finding.title,
      finding_severity: finding.severity,
      finding_fingerprint: finding.fingerprint,
      target_id: finding.target_id,
      previous_status: finding.status,
      new_status: newStatus,
    },
    rationale: reason ?? null,
  } as never);

  // Post the agent's confirmation message into the same thread the
  // user clicked from. Visual continuity: the answer appears right
  // below their action.
  const emoji = SEV_EMOJI[(finding.severity ?? 'info').toLowerCase()] ?? '🔵';
  const headline =
    action === 'suggest_fix'
      ? `${emoji} Working on a fix for "${finding.title ?? 'finding'}"…`
      : action === 'dismiss'
      ? `${emoji} Dismissed: "${finding.title ?? 'finding'}"`
      : `${emoji} Confirmed real: "${finding.title ?? 'finding'}"`;

  const blocks = [
    { type: 'text', markdown: `**${headline}**\n\n${confirmationText}` },
    { type: 'finding_ref', finding_id: finding.id },
  ];

  // The agent_messages_user_insert RLS policy only allows role='user' from
  // authenticated clients. The confirmation message is role='agent' — the
  // system speaking on behalf of the platform after a user action. That
  // requires the service-role admin client (same pattern as /api/orgs's
  // bootstrap-org-membership insert in route.ts).
  //
  // We deliberately do not use the admin client for the status update or
  // the episode insert — those should respect RLS so the wrapper can never
  // accidentally mutate another org's findings.
  const admin = createAdminClient();
  const { error: msgErr } = await admin.from('agent_messages').insert({
    thread_id,
    role: 'agent',
    blocks,
    citations: [
      { kind: 'finding', id: finding.id, label: finding.title ?? '' },
    ],
    acted_on: [
      {
        kind: episodeAction,
        target: finding.id,
        at: new Date().toISOString(),
        payload: { new_status: newStatus },
      },
    ],
  } as never);

  if (msgErr) {
    // The action succeeded; just couldn't post the confirmation.
    // Surface the partial success so the client can render its own
    // local confirmation while we figure out why the realtime stream
    // missed this one.
    return NextResponse.json(
      { ok: true, status_updated: !!newStatus, message_post_error: msgErr.message },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    status_updated: !!newStatus,
    new_status: newStatus,
  });
}
