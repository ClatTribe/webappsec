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
interface ComplianceReadinessIntent {
  kind: 'compliance_readiness';
  framework: string;          // canonical: 'soc2_type_2' | 'iso_27001' | …
  framework_label: string;    // user-facing: 'SOC 2 Type 2' | 'ISO 27001' | …
}
interface SetAutonomyIntent {
  kind: 'set_autonomy';
  /** What the user wants the agent to do without asking. */
  mode: 'ask_before_act' | 'autopilot';
  /** When set, restrict autopilot to this severity and above. */
  auto_fix_severity?: Severity;
}
interface ShowAutonomyIntent {
  kind: 'show_autonomy';
}
interface UnknownIntent {
  kind: 'unknown';
}
type Intent =
  | DismissIntent
  | ShowOpenIntent
  | ComplianceReadinessIntent
  | SetAutonomyIntent
  | ShowAutonomyIntent
  | UnknownIntent;

// Framework name aliases — what users type → (canonical_id, display_label).
// Order matters: longer / more-specific names must come before short ones
// so 'soc 2 type 2' matches before 'soc 2'.
const FRAMEWORK_ALIASES: Array<{ pattern: RegExp; id: string; label: string }> = [
  { pattern: /\b(soc[\s-]?2[\s-]?type[\s-]?(2|ii))\b/i,        id: 'soc2_type_2', label: 'SOC 2 Type 2' },
  { pattern: /\b(soc[\s-]?2[\s-]?type[\s-]?(1|i))\b/i,         id: 'soc2_type_1', label: 'SOC 2 Type 1' },
  { pattern: /\bsoc[\s-]?2\b/i,                                id: 'soc2_type_2', label: 'SOC 2' },
  { pattern: /\biso[\s-]?27001\b/i,                            id: 'iso_27001',   label: 'ISO 27001' },
  { pattern: /\bpci[\s-]?dss\b/i,                              id: 'pci_dss',     label: 'PCI DSS' },
  { pattern: /\bhipaa\b/i,                                     id: 'hipaa',       label: 'HIPAA' },
  { pattern: /\bgdpr\b/i,                                      id: 'gdpr',        label: 'GDPR' },
  { pattern: /\bfedramp\b/i,                                   id: 'fedramp_moderate', label: 'FedRAMP' },
];

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

  // "how ready am I for SOC 2?" / "soc 2 readiness?" / "soc 2 status?" /
  // "where am I with iso 27001?" / "where do i stand on hipaa?" — any of
  // these expressions tied to a recognised framework name routes to the
  // compliance-readiness intent.
  for (const fw of FRAMEWORK_ALIASES) {
    if (fw.pattern.test(t)) {
      if (
        /\b(ready|readiness|status|stand|progress|prepar|score|posture)\b/.test(t) ||
        /\bhow\s+(am|are)\b/.test(t) ||
        /\bwhere\s+(am|do)\b/.test(t)
      ) {
        return {
          kind: 'compliance_readiness',
          framework: fw.id,
          framework_label: fw.label,
        };
      }
    }
  }

  // Show autonomy / "what are you allowed to do" / "what's your autonomy"
  if (
    /\b(what.?s|show|tell\s+me)\b.*\bautonomy\b/.test(t) ||
    /\bwhat.?\s*can\s+you\s+do\b/.test(t) ||
    /\bwhat\s+are\s+you\s+allowed\s+to\s+do\b/.test(t) ||
    /\bautonomy\s+(level|state|settings)\b/.test(t)
  ) {
    return { kind: 'show_autonomy' };
  }

  // "ask me before everything" / "ask me before acting" / "co-pilot mode"
  // / "stop auto-fixing"
  if (
    /\bask\s+(me\s+)?(before\s+)?(everything|every\s+action|any\s+action|acting|act)\b/.test(t) ||
    /\bco[-\s]?pilot\b/.test(t) ||
    /\b(stop|disable|turn\s+off)\s+(auto[-\s]?fix(ing)?|autopilot)\b/.test(t)
  ) {
    return { kind: 'set_autonomy', mode: 'ask_before_act' };
  }

  // "auto-fix critical[s]" / "auto-fix highs" / "autopilot for criticals" /
  // "go autopilot on dep-CVEs above high" / "fix critical and high autonomously"
  const autoFixSev = t.match(
    /\b(auto[-\s]?fix|autopilot|auto[-\s]?merge|auto[-\s]?patch|fix\s+(critical|high|medium|low)\s+autonomously)\b/,
  );
  if (autoFixSev) {
    // Pull the severity from the surrounding context.
    const sevHit = t.match(/\b(critical|high|medium|low)s?\b/);
    if (sevHit) {
      return {
        kind: 'set_autonomy',
        mode: 'autopilot',
        auto_fix_severity: sevHit[1] as Severity,
      };
    }
    // "autopilot mode" without a severity → full autopilot.
    if (/\b(autopilot|auto[-\s]?fix\s+(all|everything))\b/.test(t)) {
      return { kind: 'set_autonomy', mode: 'autopilot' };
    }
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

  if (intent.kind === 'compliance_readiness') {
    return await handleComplianceReadiness(
      supabase,
      admin,
      thread,
      intent.framework,
      intent.framework_label,
    );
  }

  if (intent.kind === 'show_autonomy') {
    return await handleShowAutonomy(supabase, admin, thread);
  }

  if (intent.kind === 'set_autonomy') {
    return await handleSetAutonomy(supabase, admin, user.id, thread, intent);
  }

  // Fallback — polite acknowledgement.
  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown: `I'm still learning natural-language triage. For now I understand:\n\n- **"dismiss the lows"** (or highs / mediums / criticals) — bulk-dismiss findings at that severity.\n- **"what's open"** — summarise current open findings.\n- **"how ready am I for SOC 2?"** (or ISO 27001 / PCI DSS / HIPAA / GDPR) — compliance posture summary.\n- **"what's your autonomy"** / **"auto-fix critical"** / **"ask me before everything"** — view or adjust my autonomy.\n\nFor anything else, the action buttons under each finding card are wired up — give those a try.`,
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

async function handleComplianceReadiness(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  thread: { id: string; org_id: string },
  framework: string,
  frameworkLabel: string,
) {
  // Readiness summary via the RPC (org-scoped).
  const { data: readinessData, error: readinessErr } = await supabase
    .rpc('org_compliance_readiness', {
      p_org_id: thread.org_id,
      p_framework: framework,
    } as never);
  if (readinessErr) {
    return NextResponse.json({ error: `readiness rpc failed: ${readinessErr.message}` }, { status: 500 });
  }
  const summary = (readinessData ?? [])[0] as unknown as
    | {
        framework: string;
        total: number;
        passing: number;
        failing: number;
        warning: number;
        untested: number;
        readiness_pct: number;
      }
    | undefined;

  // No evidence yet? Tell the user honestly + suggest a first scan.
  if (!summary || summary.total === 0) {
    await admin.from('agent_messages').insert({
      thread_id: thread.id,
      role: 'agent',
      blocks: [
        {
          type: 'text',
          markdown: `I don't have ${frameworkLabel} evidence yet. Once your next scan completes against a registered asset, the engine ships a \`compliance_evidence.json\` and I can give you a real readiness picture.\n\nFor now I'd estimate **not enough data**. Register an asset under **Targets** or kick off a scan, and ask me again.`,
        },
      ],
      citations: [],
    } as never);
    return NextResponse.json({
      ok: true,
      intent: 'compliance_readiness',
      framework,
      total: 0,
    });
  }

  // Pull the failing + warning controls for inline context.
  const { data: postureData } = await supabase
    .from('org_compliance_posture_v')
    .select('framework, control_id, verdict, evidence_summary')
    .eq('framework', framework)
    .order('verdict')
    .order('control_id');
  const posture = (postureData ?? []) as unknown as Array<{
    framework: string;
    control_id: string;
    verdict: string;
    evidence_summary: string | null;
  }>;

  const failing = posture.filter((p) => p.verdict === 'fail');
  const warning = posture.filter((p) => p.verdict === 'warn');

  const failingBlock = failing.length
    ? `\n\n**Failing controls (${failing.length}):**\n${failing
        .slice(0, 8)
        .map((p) => `- \`${p.control_id}\` — ${p.evidence_summary ?? 'no summary'}`)
        .join('\n')}${failing.length > 8 ? `\n_…and ${failing.length - 8} more._` : ''}`
    : '';
  const warningBlock = warning.length
    ? `\n\n**Warnings (${warning.length}):**\n${warning
        .slice(0, 5)
        .map((p) => `- \`${p.control_id}\` — ${p.evidence_summary ?? 'no summary'}`)
        .join('\n')}${warning.length > 5 ? `\n_…and ${warning.length - 5} more._` : ''}`
    : '';

  // Calibrated emoji — green at 90%+, amber 70-90%, red below.
  const pctNum = Number(summary.readiness_pct);
  const emoji = pctNum >= 90 ? '🟢' : pctNum >= 70 ? '🟡' : '🔴';
  const headline = `${emoji} **${frameworkLabel} readiness: ${pctNum}%** — ${summary.passing}/${summary.passing + summary.failing + summary.warning} controls passing (${summary.untested} untested).`;

  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown: `${headline}${failingBlock}${warningBlock}\n\n_(Latest evidence per control; aggregated across all your scans.)_`,
      },
    ],
    citations: [
      // Cite up to 8 failing controls so the user can click through.
      ...failing.slice(0, 8).map((p) => ({
        kind: 'compliance_evidence',
        id: `${framework}:${p.control_id}`,
        label: p.control_id,
      })),
    ],
  } as never);

  return NextResponse.json({
    ok: true,
    intent: 'compliance_readiness',
    framework,
    framework_label: frameworkLabel,
    readiness_pct: pctNum,
    total: summary.total,
    passing: summary.passing,
    failing: summary.failing,
    warning: summary.warning,
    untested: summary.untested,
  });
}

// ---------------------------------------------------------------------------
// Phase E v1 — autonomy NL handlers
// ---------------------------------------------------------------------------

interface AutonomyPrefsShape {
  default?: string;                 // 'ask_before_act' | 'autopilot'
  auto_fix_severity?: Severity | null;
  auto_dismiss?: boolean;
  slack_notify?: string;
  [k: string]: unknown;
}

async function loadAutonomy(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
): Promise<AutonomyPrefsShape | null> {
  const { data } = await supabase
    .from('agent_memory_preferences')
    .select('autonomy')
    .eq('org_id', orgId)
    .single();
  const row = data as unknown as { autonomy: AutonomyPrefsShape } | null;
  return row?.autonomy ?? null;
}

async function handleShowAutonomy(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  thread: { id: string; org_id: string },
) {
  const autonomy = await loadAutonomy(supabase, thread.org_id);
  if (!autonomy) {
    await admin.from('agent_messages').insert({
      thread_id: thread.id,
      role: 'agent',
      blocks: [
        {
          type: 'text',
          markdown:
            `I don't have autonomy preferences on file yet. New orgs default to **ask_before_act** — I won't take state-changing actions without confirming.\n\nYou can change this by telling me, e.g.: "auto-fix critical" or "ask me before everything".`,
        },
      ],
      citations: [],
    } as never);
    return NextResponse.json({ ok: true, intent: 'show_autonomy', preference: null });
  }

  const mode = autonomy.default ?? 'ask_before_act';
  const sev = autonomy.auto_fix_severity;
  const autoDismiss = autonomy.auto_dismiss ? 'on' : 'off';
  const slackNotify = autonomy.slack_notify ?? 'always';

  const modeLine =
    mode === 'autopilot' && sev
      ? `🚀 **Autopilot** for **${sev}** and above`
      : mode === 'autopilot'
      ? `🚀 **Autopilot** (all severities)`
      : `🙋 **Ask before acting** — I'll confirm before any state-changing action`;

  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown:
          `Here's my current autonomy for your org:\n\n${modeLine}\n\n- **Auto-dismiss (KNN false-positive learner):** ${autoDismiss}\n- **Slack notify on critical events:** ${slackNotify}\n\nTo change: "auto-fix critical" · "ask me before everything" · "autopilot mode".`,
      },
    ],
    citations: [],
  } as never);

  return NextResponse.json({
    ok: true,
    intent: 'show_autonomy',
    preference: autonomy,
  });
}

async function handleSetAutonomy(
  supabase: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  thread: { id: string; org_id: string },
  intent: { mode: 'ask_before_act' | 'autopilot'; auto_fix_severity?: Severity },
) {
  const current = (await loadAutonomy(supabase, thread.org_id)) ?? {};
  const previous = { ...current };

  // Compose the next autonomy state. Preserve unrelated keys; only flip
  // the fields the intent dictates.
  const next: AutonomyPrefsShape = {
    ...current,
    default: intent.mode,
  };
  if (intent.mode === 'autopilot') {
    if (intent.auto_fix_severity) {
      next.auto_fix_severity = intent.auto_fix_severity;
    }
    // If user said full autopilot with no severity, clear the gate.
    else if (current.auto_fix_severity == null) {
      next.auto_fix_severity = null;
    }
  } else {
    // ask_before_act revokes any prior auto-fix permission so the
    // promise of the new mode actually holds.
    next.auto_fix_severity = null;
  }

  // Only admins can change org autonomy. RLS on the table is admin-update
  // only; we'll see the error inline if the policy denies.
  const { error: updErr } = await supabase
    .from('agent_memory_preferences')
    .update({
      autonomy: next,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('org_id', thread.org_id);

  if (updErr) {
    await admin.from('agent_messages').insert({
      thread_id: thread.id,
      role: 'agent',
      blocks: [
        {
          type: 'text',
          markdown: `I couldn't update autonomy — that's an admin-only setting. Ask your org admin to flip it (or use the settings page, coming soon).\n\n_(Error: ${updErr.message})_`,
        },
      ],
      citations: [],
    } as never);
    return NextResponse.json(
      { ok: false, intent: 'set_autonomy', error: updErr.message },
      { status: 200 }, // user-actionable, not an HTTP failure
    );
  }

  // Record the change as an episode for the audit trail + suppression
  // learning isn't affected; this is a separate fact-class.
  await admin.from('agent_memory_episodes').insert({
    org_id: thread.org_id,
    thread_id: thread.id,
    user_id: userId,
    agent_action: 'autonomy_adjusted',
    payload: { previous, next },
    rationale: null,
  } as never);

  // Confirmation message.
  const confirmLine =
    intent.mode === 'autopilot' && intent.auto_fix_severity
      ? `🚀 **Autopilot** is now on for **${intent.auto_fix_severity}** severity and above. I'll act without asking — and post here when I do.`
      : intent.mode === 'autopilot'
      ? `🚀 **Autopilot** is on. I'll act on findings without asking first.`
      : `🙋 **Ask-before-act** is on. I won't change anything without your confirmation. I'll keep flagging findings and you can dismiss / fix from the cards.`;

  await admin.from('agent_messages').insert({
    thread_id: thread.id,
    role: 'agent',
    blocks: [
      {
        type: 'text',
        markdown:
          `${confirmLine}\n\n_(Heads-up: the underlying auto-fix runner ships with engine Phase 12. Until then, this preference is recorded — pending actions are visible but will still wait for you.)_`,
      },
    ],
    citations: [],
    acted_on: [
      {
        kind: 'autonomy_adjusted',
        at: new Date().toISOString(),
        payload: { previous, next },
      },
    ],
  } as never);

  return NextResponse.json({
    ok: true,
    intent: 'set_autonomy',
    previous,
    next,
  });
}
