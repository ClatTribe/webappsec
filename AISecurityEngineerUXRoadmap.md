# `AISecurityEngineerUXRoadmap.md` — wrapper roadmap for an AI-native security engineer

**Audience:** webappsec contributors. This doc is the wrapper-side
proposal for delivering the engine team's
[`strix/AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md)
phases A-H **as an AI-native, conversation-first product** — not as a
traditional dashboard with security findings.

> **The shift this doc makes.** Phase A-H in the engine team's spec
> reads like a SaaS product roadmap (onboarding, dashboard, settings,
> billing). That's the *minimum viable contract*. But the customer is
> a vibe-coded founder who picked Cursor over VS Code because Cursor
> *talks back*. They didn't want a better autocomplete — they wanted a
> partner who codes for them. They'll choose us over Aikido / Snyk for
> the same reason: not because we have better lists and filters, but
> because we feel like *an engineer they hired*.
>
> This doc reframes every Phase A-H deliverable around that. **The
> agent is the product. Everything else is supporting cast.**

> **Companion to:**
> [`engine-usage.md`](engine-usage.md) (engine-emit contract),
> [`usage.md`](usage.md) (product summary + Phase A-H gap inventory),
> [`roadmap.md`](roadmap.md) §19 (plumbing-tier work),
> [strix `AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md) (the engine team's UX roadmap this doc proposes implementation for).

---

## Contents

0. [The shift — why dashboards are the wrong default](#0-the-shift)
1. [The agent has shape — design language](#1-design-language)
2. [Surfaces — where the agent lives](#2-surfaces)
3. [Phase A — The agent arrives](#3-phase-a)
4. [Phase B — Triage as conversation](#4-phase-b)
5. [Phase C — Compliance as a living document](#5-phase-c)
6. [Phase D — Tools the agent uses](#6-phase-d)
7. [Phase E — Autonomy is a slider, not a toggle](#7-phase-e)
8. [Phase F — Ambient awareness](#8-phase-f)
9. [Phase G — Each org gets its own agent](#9-phase-g)
10. [Phase H — Trust pages as agent portfolios](#10-phase-h)
11. [Generative UI components — the new design system](#11-generative-ui-components)
12. [How this changes the previous PR plan](#12-how-this-changes-the-pr-plan)
13. [Implementation specifics — schema, routes, components](#13-implementation-specifics)
14. [Open questions](#14-open-questions)

---

## 0. The shift

### What the existing roadmap got right and wrong

Right:
- The GitHub-App-first surface (PR comments where the founder lives).
- The five personas + tier layout.
- The eventual auto-fix flow.
- The compliance-pack handoff.

Wrong (or at least, "necessary but not sufficient"):
- A **dashboard with a findings inbox** is the 2018 model. The
  customer doesn't want to log in and click through 47 issues —
  they want the agent to surface *the two that matter today* and
  *do something about them*.
- A **settings page** is friction for a founder who doesn't know what
  "MFA enforcement attestation" means yet. The agent should *infer*
  the right defaults and explain them in plain language.
- A **scan creation form** is a tool. The customer doesn't want a
  tool — they hired an engineer.
- An **integrations page** is configuration. The agent doesn't *have*
  integrations; it *uses tools* the way a human engineer uses Slack
  and Jira.

### What "AI-native" means for this product

It means **the agent is the interface, not the back-end**.

The user's primary interaction is conversation:

```
You    " any new issues today? "

Strix  " yes — 2 critical and 3 medium since yesterday's deploy.
         the critical one is interesting:
         someone refactored auth.ts in PR #142 and removed the
         middleware that checks user.role on /api/admin/*.
         I verified the bug is reachable from the live site.
         I've drafted a fix PR — want to see it? "

You    " show me the diff "

Strix  [renders inline diff with the missing middleware re-added,
        plus a regression test, plus a CHANGELOG entry]

You    " merge it "

Strix  " merged. I added a test so this regression can't recur.
         I also created a Linear ticket for the team to review the
         deploy gate that let this through.
         the 3 medium findings are all the same dep-CVE class —
         lodash@4.17.20 in three different services.
         want me to bump them? "
```

That's the product. Lists, dashboards, forms — they're a *fallback*
for when the conversation isn't the right modality. They are not the
thing you optimise for.

### What this doc commits to

1. **Conversation is the primary surface.** Every Phase A-H feature
   gets a "what's the conversation?" answer first.
2. **The agent has memory.** It knows your stack, your team, your
   past decisions, your false-positive patterns, your customers'
   trust questionnaires.
3. **The agent is proactive.** It pings you when something matters.
   It does not wait for you to refresh a dashboard.
4. **The agent acts on your behalf with calibrated autonomy.** A
   slider — co-pilot ↔ autopilot — per category, per severity.
5. **The agent shows its work.** Every claim is verifiable. Every
   action is auditable. No black boxes.
6. **Generative UI for the long-tail.** The agent builds the view it
   needs on demand instead of forcing one canonical layout.
7. **The dashboard still exists** — but as the *secondary* surface
   (Persona 2 AppSec engineer + audit-evidence rendering). Persona 1
   (vibe-coded founder) lives in chat + PR comments + Slack.

---

## 1. Design language

### 1.1 Presence

The agent always has a *visible presence* somewhere:

- **In-app:** persistent chat panel, never-collapsed by default.
  Avatar + name (`Strix`) + status indicator (idle / thinking / acting
  / waiting on you).
- **In Slack:** a bot user that posts in `#security` or whatever
  channel the org configures, with the same status indicators.
- **In GitHub:** PR comments and Check Runs from a branded bot.
- **In email:** weekly digest signed by the agent.

Customers should feel like *the same engineer* is talking to them
across all surfaces. Same name, same voice, same memory.

### 1.2 Conversation as the primary surface

The default landing experience after onboarding is **the chat**, not a
dashboard. The chat shows:

- **Latest digest** (top) — what the agent did, what changed, what
  needs you. Auto-refreshes as new events land.
- **Active conversation thread** — wherever you and the agent left
  off.
- **Suggestions** — the agent surfaces 1-3 things it could do next.
  ("Want me to bump lodash across all services?" / "Want me to write
  the SOC 2 SAQ response for control CC6.1?")

You can switch to traditional views via the **command palette
(Cmd+K)** — but the chat is home.

### 1.3 Generative UI

The agent doesn't pick from a fixed catalogue of components — it
**generates the view that fits**. Examples:

- "Show me which services use vulnerable lodash" → agent renders an
  on-demand table grouped by service with version + reachability +
  fix link.
- "Compare our SOC 2 readiness this month vs. last" → agent renders
  a per-control delta chart inline.
- "Walk me through the auth bypass you found" → agent renders a
  collapsible kill-chain timeline with screenshots and code excerpts.

These views are **disposable** — they live in the chat thread, can be
saved to a workspace if useful, and aren't part of the persistent
dashboard. The principle: *the agent shapes the UI to the
conversation*, not the other way around.

Implementation: chat messages can contain rich blocks (table,
chart, code, timeline, image, diff, tree, kanban) that render via a
typed `agent_artifact` schema. The agent picks blocks; the wrapper
renders them.

### 1.4 Memory and continuity

The agent remembers:

- **Codebase facts:** stack, frameworks, deploy targets, npm tree,
  team size.
- **Behavioural patterns:** which findings the org dismisses (and
  why), which it fixes promptly, which it snoozes.
- **People:** team members, their GitHub handles, their Slack
  handles, their roles.
- **Past decisions:** "you marked SSRF in `/api/health` as a known
  intentional exception three months ago, here's the comment."
- **Customers' compliance landscape:** which audits the org is
  preparing for, which questionnaires it's answered, what each
  control means in their context.

The wrapper persists this in a per-org agent memory store
(`agent_memory.facts`, `agent_memory.episodes`,
`agent_memory.preferences`). Every meaningful interaction updates it.

This is what makes the agent feel *senior*: a junior pen-tester
re-discovers your stack every engagement. A senior who's been with
you for two years just... knows.

### 1.5 Verifiability is non-negotiable

Every agent claim is verifiable:

- **Citations on every assertion.** "I found SQLi at /api/users" →
  click to see the curl PoC, the response, the code line.
- **Provenance chips** on every tool output. Engine PR #139's
  6-value `actor.provenance` enum (trusted_source / intel_feed /
  target / operator_input / framework / mixed) shows up as coloured
  pips on every chat message that consumed agent-tool output.
- **Reasoning trace** expandable per claim. The agent's `think`
  tokens are visible (collapsed by default; expandable when the user
  asks "why do you think so?").
- **Auditable actions.** Every action the agent takes —
  PR opened, ticket created, finding dismissed, secret rotated —
  appears in the activity feed with timestamp, evidence, and user
  attribution if applicable.

If the agent says "I'm 90% confident this is exploitable," clicking
the 90% reveals the calibration breadcrumb (verification_status,
counter-proof, agent's own reasoning).

### 1.6 Autonomy is a slider, not a toggle

Trust isn't binary. The customer should be able to dial it
per-category, per-severity:

```
                co-pilot                                 autopilot
                    │                                         │
                    ▼                                         ▼
SQLi (critical)     [ ask before fix ]      [ auto-fix and tell me ]
SQLi (medium)       [ ask before fix ]
XSS (any)           [ ask before fix ]      [ auto-fix and tell me ]
Dep-CVE (KEV)                               [ auto-fix and tell me ]
Dep-CVE (any)       [ ask before fix ]
Compliance gap      [ draft + ask ]         [ draft + post ]
Slack notify        ─────────[ always on ]──────────────
Linear ticket                [ always on for severity≥high ]
```

A new customer starts at "ask before fix" everywhere. As they trust
the agent (signal: high acceptance rate of suggestions), they slide
toward autopilot category-by-category.

The autonomy state is itself **conversation-accessible**: "be more
aggressive with dep-CVEs" → agent updates the slider + confirms.

### 1.7 Transparency by default

The agent never silently does anything important. Every state-changing
action has:

- A **pre-action announcement** ("I'm about to apply this fix to 3
  files; here's the diff. confirm?")
- An **audit-log entry** with full payload.
- A **reversal path** ("undo this last action").

The customer can configure: pre-action confirmation always on, off
for non-critical, off entirely (for power users on autopilot).

### 1.8 Multi-modal evidence

Findings carry the agent's evidence in whatever form is most useful:

- **Code excerpt** — for SAST and SCA findings.
- **Curl PoC** — for DAST findings.
- **Browser screenshot** — for XSS / clickjacking / UI-touching findings.
- **Network diagram** — for SSRF / cross-domain / cookie-scoping findings.
- **Diff view** — for auto-fix proposals.
- **Trajectory timeline** — for "how did I find this?" questions.

The chat blocks (1.3) include all of these as first-class types.

---

## 2. Surfaces

The agent doesn't have *one* interface. It has *presence* across the
surfaces the customer already uses:

### 2.1 The Chat (in-app, primary)

The default home page after onboarding. Persistent thread with the
agent, plus a sidebar showing "recent threads" (one per finding /
incident / engagement). Cmd+K opens the command palette for faster
nav.

**What lives here:** every conversation, the latest digest, action
buttons, generative artefacts (tables / charts / diffs the agent
renders inline).

### 2.2 The PR (GitHub)

The agent reviews every PR before the customer does. Posts inline
comments on findings. Posts a single Check Run summary. Opens fix
PRs with the same bot identity. Replies to threaded discussion the
human reviewer starts.

**What lives here:** per-PR scan results, fix proposals, threaded
discussion with reviewers, auto-merge-block on critical findings.

### 2.3 The Slack channel

The agent joins the customer's `#security` channel as a bot user.
Posts daily digests. Replies to `@strix` mentions. Pings the
on-call engineer for critical findings. Opens private threads for
sensitive discussions.

**What lives here:** team-visible alerts, slash commands, async
discussion that doesn't belong in a PR.

### 2.4 The Living Doc

Some artefacts are documents that *update over time*: the auditor
pack, the trust page, the security runbook, the SOC 2 SAQ.

These are not downloads. They are URLs the agent maintains. The
auditor opens the URL today; the agent has updated it since
yesterday's scan; the URL still works.

**What lives here:** auditor pack, trust page, security runbook,
SOC 2 SAQ, ISO 27001 SoA, vendor-questionnaire response library.

### 2.5 The Console (secondary)

The traditional dashboard exists for Persona 2 (AppSec engineer who
wants metrics + filters + bulk actions) and for cases where the
chat isn't the right modality (e.g. visual inspection of a kill
chain across 50 events).

**What lives here:** findings inbox with filters, scan history,
team / repo views, raw event timeline, settings.

The console is *a tool the agent uses* — when you ask "show me all
auth issues this month," the agent navigates the console and
displays a filtered view in chat. The customer can also navigate
the console directly, but the agent's chat handles ~90% of
real-world flows.

---

## 3. Phase A — The agent arrives

**Engine-team goal (verbatim):** *"a founder signs up, installs the
GitHub App, and sees their first finding inline on a PR within 5
minutes."*

### What the conversation looks like

```
[ founder signs up with email + magic link ]

Strix  " hey — I'm Strix, your AI security engineer. before I dig
         into your code, can you tell me about what you're building?
         the more I know, the better I can prioritize. "

You    " we're building a SaaS for college applications, Next.js +
         Supabase, deployed on Vercel "

Strix  " got it. that means: SQLi, IDOR, and Supabase RLS misconfigs
         are top priority for me. I'll also keep an eye on the
         vendor footprint (Vercel + Supabase + your CDN) for
         configuration drift.

         to do my job I need to read your repo. want me to install
         the GitHub App now? takes 30 seconds. "

You    [ click 'install ' ]

Strix  " thanks. I have access to 4 repos:
           - getedunext-frontend
           - getedunext-api
           - getedunext-admin
           - getedunext-marketing
         I'm scanning all four. while that runs, what's your
         production URL? I'll set up a daily DAST baseline. "

You    " https://www.getedunext.com "

Strix  " checked — it's up, served by Vercel, TLS is fine. I'll do
         a baseline scan now and re-scan daily at 03:00 UTC.

         your first scan results are coming in — 1 critical SCA
         finding (jsonwebtoken@8.5.0 has CVE-2022-23529, RCE in your
         api repo), 4 medium SCA findings (lodash, ws, semver,
         qs — typical npm hygiene). no SAST issues yet.

         the critical one matters: jsonwebtoken is in your auth path.
         I drafted a fix PR — bump to 9.0.2, no API changes needed.
         want to see it? "

You    " yes "

Strix  [ renders fix-PR diff inline + linked GitHub PR ]
```

That's the product. The founder hasn't navigated a dashboard, hasn't
configured anything, hasn't read CVSS vectors. They've had a
conversation with someone who understood what they're building and
took action.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Conversational onboarding flow** | One screen, chat-style. Replaces the current multi-step form. Agent asks ~3-4 questions, infers the rest. | M |
| **Repo / stack inference** | After GitHub install, agent reads `package.json`, framework markers (`next.config.js`, `wrangler.toml`, etc.), infers stack. Stored in `agent_memory.facts.stack`. | S |
| **Agent's own personality / voice** | System prompt + tone guide for the agent's chat outputs. Same name, same voice, same memory across all surfaces. Versioned per release. | XS (one config file) |
| **Live findings stream into chat** | As the engine emits `finding.created`, the agent posts a chat message in the form *"I found X. it matters because Y. want me to do Z?"* — not a raw finding card. | M |
| **PR-comment renderer** (engine team A.5) | Same as the previous roadmap, but with the agent's voice. Comment is signed by the agent, links back to the chat thread. | L |
| **GitHub App install + first-scan trigger** | Same as the previous roadmap. | M |
| **Production URL capture as part of conversation** | Agent asks; customer pastes; agent validates + creates `web_application` target. No separate form. | XS |

The traditional onboarding wizard (steps 1-7 in the engine team's
roadmap) is **replaced by the conversation**. Steps still exist
internally — sign up, create org, install app, capture URL — but as
*the agent's actions* during the conversation, not as separate
screens the customer clicks through.

### Acceptance criteria

- Time-to-first-finding < 5 min from sign-up.
- Customer never sees a "settings" or "configure" page during
  onboarding. The agent infers and explains.
- The first chat message after sign-up is the agent introducing
  itself and asking about the company.
- The first action the agent takes is the GitHub App install — not
  the customer navigating to a settings page.

### What's already shipped that carries over

- Multi-tenant org schema + RLS + audit_log (the substrate the
  agent runs on).
- Engine PR #29 preflight (the agent's "is the URL up?" check).
- Coverage banner (PR #64) — when the agent's scan can't reach the
  target, it says so honestly in chat instead of pretending.

### New components needed

- `<ChatThread>` — the primary surface. Streaming response, inline
  artefacts, citations, suggestions row at the bottom.
- `<AgentMessage>` — composed of typed blocks (text, table, chart,
  code, diff, screenshot, action-button-row).
- `<AgentSuggestions>` — 1-3 buttons the agent surfaces beneath each
  message ("Apply Fix", "See diff", "Ignore for this release").
- `<OnboardingChat>` — variant of `<ChatThread>` for the first-run
  experience. Pre-seeded with the agent's introduction.

---

## 4. Phase B — Triage as conversation

**Engine-team goal:** *"customers spend < 1 minute per finding to
triage; false-positive rate < 10%."*

### What the conversation looks like

Daily digest in chat (or Slack):

```
Strix  " yesterday's scans found 12 issues across 3 repos:
           critical : 1   ← matters
           high     : 2
           medium   : 6
           low      : 3

         the critical one is a regression — someone removed the
         auth middleware on /api/admin/* in PR #142. I verified
         it's reachable from production (you'd be able to hit
         /api/admin/users without a session cookie right now).

         I drafted a fix. want me to apply it, or want to look first?

         the 2 high-severity findings are both stored XSS in the
         feedback form. same root cause: server-rendered user
         content without escape. one fix covers both.

         the 6 medium are all the same dep-CVE class — outdated lodash
         in 3 services. you fixed an identical batch 10 days ago by
         bumping all 3; should I do the same?

         the 3 low are header-config nits (X-Frame-Options missing
         on 3 routes). I can fix in one PR. "

You    " apply the critical fix. show me the XSS diff. dismiss the
         lows — we ship behind a Cloudflare WAF that handles those. "

Strix  " on it.
         critical fix applied — PR #289 opened with regression test.
         XSS diff: [ inline diff ]
         lows dismissed across all routes. I've added 'X-Frame-Options
         missing on routes behind Cloudflare WAF' to your suppression
         rules so I won't re-flag this class. "

You    " confirm the lodash bump too "

Strix  " bumping lodash@4.17.20 → 4.17.21 in 3 services. PR #290.
         I'll let you know when CI passes. "
```

That's triage. No filters, no bulk-action toolbar, no
"recently dismissed" view. The customer responded in natural
language; the agent did the right things, learned the suppression
rule for next time.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Daily digest as chat post** | Agent composes a digest after the daily scan; posts to chat + Slack. Group by exploit chain (engine `finding_chains.json`), explain in plain language, surface the 1-2 things that matter. | M |
| **Per-finding chat thread** | Click a finding in the digest → opens a sub-thread with that finding's evidence, the agent's reasoning, action buttons. Persists across sessions. | M |
| **NL triage actions** | "dismiss the lows" / "fix the critical" / "snooze for 30 days" — agent parses intent, applies action, confirms. Same NL handler covers all triage shortcuts. | L |
| **Suppression rule learning** | When the customer dismisses a class with a reason ("we have Cloudflare WAF"), agent stores it as a per-org suppression rule. Next scan, the agent doesn't re-flag — but writes a chat note: "I would have flagged X but your Cloudflare WAF rule covers it." | M |
| **`finding_chains.json` ingestion** | Engine PR #219 §4a v2. Already in the previous roadmap (PR #80). Reframed: chains drive the *narrative* of the digest, not just a UI grouping. | M |
| **`compliance_evidence.json` ingestion** | Engine PR #219 §4b. Reframed: compliance posture is part of the digest ("you went from 87% to 89% SOC 2 readiness today"), not a separate page. | M |
| **Generative UI artefacts** | Tables, diffs, charts the agent emits inline as part of triage answers. Typed `agent_artifact` schema; rendered by `<AgentMessage>`. | M |

The traditional findings inbox (PR #46-#64's primary surface)
becomes the **secondary console** for Persona 2 (AppSec engineer who
wants the filtered list view). Persona 1 (vibe-coded founder)
handles 90% of triage from chat.

### What's already shipped that carries over

- Casefile per finding (PR #42, #46, #47, #48) — confidence,
  reasoning_trace, counter_proof, kill_chain, trajectory. **All of
  this is the agent's evidence when the customer asks "why?"**
- FP feedback loop (PR #45, #47) — the substrate for suppression-rule
  learning.
- Cross-scan dedup via fingerprint + reproducibility_token (PR #29,
  #42) — the substrate for "is this a regression or a recurring
  issue?" reasoning.
- Coverage banner (PR #64) — when the agent's report would mislead,
  it says so.

### New components needed

- `<DailyDigestMessage>` — special variant of `<AgentMessage>` for
  the daily summary. Always rendered first in the chat scroll on
  first-visit-of-day.
- `<FindingThread>` — sub-thread keyed to a `finding_id`. Shows the
  agent's reasoning, evidence, action history, and conversation.
- `<NLTriageHandler>` — backend tool the agent calls to parse "dismiss
  the lows" / "fix this" / "snooze for 30 days" into structured
  state changes.
- `<SuppressionRule>` schema + UI — when the customer says "this is
  a known FP because X," that becomes a per-org suppression rule the
  agent surfaces in future scans ("I would have flagged Y but your
  rule from Mar 14 covers it").

---

## 5. Phase C — Compliance as a living document

**Engine-team goal:** *"replace Vanta/Drata for security-finding
evidence collection."*

### What the conversation looks like

```
You    " how ready am I for SOC 2 Type 2? "

Strix  " right now:
           SOC 2  : 89% ready — 11 of 12 controls passing
           ISO 27001 : 76% — needs 4 more controls
           PCI DSS : N/A (no payment data flow detected)

         the SOC 2 control failing is CC7.2 (system monitoring) —
         we don't have evidence of log retention. that's not a
         finding I can fix; it's a process you need.

         I've drafted the SAQ response for the 11 passing controls
         based on the last 90 days of scans. you can review it
         live: [trust.getedunext.com/soc2-saq]

         when's your audit kickoff? I can suggest a remediation
         plan if you tell me the deadline. "

You    " March 15. how do I close CC7.2? "

Strix  " three options. I'll draft any one of them as a Notion doc
         + Linear epic.

         option 1: configure Vercel log drain to a SIEM
                   (Datadog / Sumo / Splunk). 2-3 hours of work.
                   I can write the IaC change.

         option 2: enable Supabase audit log retention + add a
                   Cloudflare logpush. 4 hours. mid effort.

         option 3: skip — but tell the auditor in your SAQ that
                   you don't have monitoring in place, with a
                   target date for adding it. saves time, costs
                   trust with the auditor.

         what's your preference? "

You    " option 2. write it up. "

Strix  " on it. I'll have the IaC change as a draft PR by EOD,
         and the Notion doc explaining the change for your auditor
         by tomorrow morning.

         in the meantime, your auditor can use this URL to see
         current evidence:
         https://trust.getedunext.com/soc2-evidence

         I auto-update it after every scan. it carries the
         cryptographic chain (run.signature.json) so they can
         verify the evidence wasn't tampered with. "
```

Compliance isn't a tab. It's a conversation, and the artefacts
(SAQ, audit pack, trust page) are *living documents the agent
maintains*.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **`compliance_evidence.json` ingestion** | Engine PR #219 §4b. Per-control verdict (`pass`/`fail`/`warn`/`info`/`untested`). The agent reasons over this in chat. | M (was PR #82 in old roadmap) |
| **Living trust page** | URL the agent maintains, updates after every scan. Customer / auditor can bookmark it. Includes signed `run.signature.json` chain. | L |
| **Living SAQ doc** | Per-framework auditor-questionnaire response, agent-maintained. Drafts an answer per control based on the latest scan + customer's policy decisions. | L |
| **Conversational compliance Q&A** | The agent answers "how ready am I for SOC 2?" / "what's failing?" / "what would close CC7.2?" with cited evidence + concrete options. | M |
| **Remediation plan generation** | When a customer asks "how do I close X?", the agent drafts: option list, effort estimate per option, IaC PR for the option the customer picks. | M |
| **Auditor share-link** | Read-only time-bounded URL. Customer shares with auditor; auditor sees current evidence; access is audit-logged. | S (was PR #88) |

### What's already shipped that carries over

- Compliance overlay (PR #52) — becomes the *content source* for the
  agent's compliance answers, not the primary surface.
- Compliance pack ZIP (PR #50) — becomes the *download fallback* for
  customers who want a static snapshot. Living trust page is the
  primary deliverable.
- Compliance posture card (PR #52) — one of the chat artefacts the
  agent emits ("here's where you stand").

### New components needed

- `<TrustPage>` — public route, agent-maintained content, auto-
  updates from `compliance_evidence.json` after each scan.
- `<LivingDoc>` — generic primitive: a markdown / structured doc
  the agent writes to and the customer reads. Powers SAQ, trust
  page, runbook, postmortem.
- `<ComplianceConversation>` — backend handler for "how ready am I
  for X?" → reads `compliance_evidence.json` aggregated across
  scans, composes the answer.
- `<RemediationPlanGenerator>` — backend tool the agent uses for
  "how do I close X?" → returns option list with effort estimates.

---

## 6. Phase D — Tools the agent uses

**Engine-team goal:** *"meet customers where they are. Slack, Linear,
Jira, GitHub annotations."*

### Reframe

The wrapper doesn't have *integrations*. The agent has **tools** —
the way a real engineer uses Slack, Jira, and GitHub. The customer
*sees the agent using them*; they don't configure them as separate
products.

### What the conversation looks like

```
You    [ in Slack #engineering ]
       " @strix what's the security risk of merging
         frontend#142 today? "

Strix  [ replies in thread ]
       " I scanned frontend#142 — no new findings. but I noticed
         it touches the auth flow. let me dig deeper... "

       [ 30s later, same thread ]

       " confirmed clean. the change refactors useSession but
         doesn't alter the auth path. CSRF + XSS coverage is the
         same as main. safe to merge.

         I left a Check Run on the PR with the same conclusion. "

You    " thanks "

Strix  [ posts in #ops 4 hours later ]
       " heads up — I detected 3 new KEV-listed CVEs match
         dependencies in your stack:
           CVE-2024-XXXX  (jsonwebtoken in api repo)
           CVE-2024-YYYY  (axios in 2 services)
           CVE-2024-ZZZZ  (express-rate-limit, transitive only)

         the first one is unauthenticated RCE on the auth path.
         I'm opening a fix PR now. expect it within 5 min. "
```

The customer's experience: the agent is *in their Slack*, posting
when relevant, replying when mentioned, doing what a teammate would.
There is no "Slack settings" page where the customer configures
which alerts go where — the agent figures that out from
conversation context (this org has Slack; they have a `#security`
channel; that's where this kind of thing belongs).

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Slack as a presence** | Agent joins a Slack workspace, can be DM'd or `@mentioned`, posts proactively. OAuth install flow + slash commands. | L (was PR #89) |
| **Linear / Jira as agent tools** | When the agent decides "this needs a ticket," it creates one. The customer doesn't choose what gets ticketed; the agent does, calibrated by the autonomy slider. | M each (PR #90, #91) |
| **GitHub Code Scanning as agent surface** | SARIF forward (PR #72 in old roadmap). Agent's PR comments reference the GitHub Security tab where applicable. | S |
| **Generic outbound webhook** | For the customer's custom internal tool (Datadog / PagerDuty / homegrown). Agent calls it when configured. | S |
| **Public REST API + per-org keys** | For the customer's own automations. The agent can also be invoked over the API (programmatic agent access). | M |
| **CI integration packs** | GitHub Actions composite action — published. The agent's PR-comment flow already exists; the action is for customers running scans in their own CI. | S |

The wrapper *exposes* these as configurable, but the customer's
mental model is **"the agent uses these tools"**, not "I have
integrations."

### What's already shipped that carries over

- Slack webhook (PR #62) — becomes the entry point for proper
  Slack-app upgrade.
- CI snippet generator (PR #57) — becomes the published GitHub
  Actions composite.
- Audit log infra — every agent action via these tools writes an
  `audit_log` entry.

---

## 7. Phase E — Autonomy is a slider

**Engine-team goal:** *"customers click 'Apply Fix' on a PR comment
and get a fix PR opened automatically."*

### Reframe

"Apply Fix" as a one-time button click is the basic case. The bigger
unlock is **the autonomy slider** (§1.6). Once a customer trusts the
agent on a category, they don't want to click "Apply Fix" 47 times —
they want to say "you fix critical and high autonomously, ask me on
medium."

### What the conversation looks like

```
You    [ in chat ]
       " be more aggressive with dep-CVEs. fix any critical or
         high autonomously. I'll review medium. "

Strix  " updated. I'll auto-fix critical and high dep-CVEs from
         now on. you'll get a daily digest summarising what I did.

         heads-up: under this rule, the 2 jsonwebtoken bumps from
         this morning's scan would have been auto-merged.
         retroactively apply? "

You    " yes "

Strix  " on it. opening 2 PRs.
         I'll auto-merge them once CI passes (or notify if it doesn't).

         I won't touch anything outside dep-CVEs without asking. "

[ next morning, in Slack #engineering ]

Strix  " good morning. yesterday's autonomous activity:

         fixed (2)  : jsonwebtoken bumps in api + admin repos
         opened (1) : draft PR for missing X-Frame-Options on 3 routes
                      (waiting your review — header config feels like
                       team policy)
         dismissed (4) : repeat of last week's TLS-cipher info findings,
                          same suppression rule.

         no critical findings to escalate.
         have a good one. "
```

The autonomy slider is itself **agent-mediated**. The customer adjusts
it by talking to the agent. The agent confirms, demonstrates with an
example, can offer to retroactively apply. There's a settings page
that mirrors the slider state for completeness, but conversation is
primary.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Autonomy schema** | Per-org `agent_autonomy` table: per-category, per-severity, per-action setting. JSON-backed for flexibility. | S |
| **NL autonomy adjustment** | "be more aggressive with X" / "always ask me before fixing Y" — agent parses intent, updates slider, confirms. | M |
| **Auto-action audit log** | Every agent-initiated action (fix PR opened, ticket created, finding dismissed via suppression rule) writes `audit_log` with `actor_type='agent'`. | XS |
| **Reversal path** | Every auto-action has an "undo" button in the daily digest. Reverts the change + tells the agent "don't do this again unless I confirm." | S |
| **Pre-action confirmation** (configurable) | At minimum: critical-severity actions can require confirmation regardless of slider. Defaults sensible; customer can disable for power-user mode. | XS |
| **Auto-fix engine integration** | Same as the previous roadmap: depends on engine Phase 12. Wrapper-side stub now (PR #95), full impl post-engine (PR #96). | S now + L later |

### What's already shipped that carries over

- Verify-fix rescan (PR #61) — becomes the "did the auto-fix work?"
  loop. Agent runs verify-rescan automatically after applying a fix.
- Cancel → SIGTERM (Pillar 0) — becomes the agent's "abort what
  you're doing" handle. Customer can interrupt mid-action.

---

## 8. Phase F — Ambient awareness

**Engine-team goal:** *"customers see their security posture trend in
real-time, alerted on regressions."*

### Reframe

Trend dashboards are a *fallback*. The default is the agent **noticing
and reaching out**.

### What the conversation looks like

```
[ at 03:14 UTC, automatic ]

Strix  [ posts in Slack #security ]
       " @on-call : drift detected in production.

         a new endpoint /api/internal/users appeared in the surface
         map at 03:00 UTC scan. it returns user data without any
         auth check. I verified it's reachable from the public
         internet right now.

         this looks like a Vercel-deploy regression. someone
         shipped main 4 minutes ago.

         I've drafted a hotfix PR (#291) reverting the deploy +
         adding back the middleware. waiting your review before
         merging — production change. "

You    [ join the thread ]
       " who shipped main? "

Strix  " commit a3f2b8 by @alice — refactored the API router and
         removed the middleware mount on the /internal subtree.
         likely accidental — the diff in the original PR (#287)
         had a comment 'should we keep the auth here? probably
         yes — leaving for follow-up' that wasn't addressed. "

You    " merge the hotfix "

Strix  " merged. production is back behind auth as of 03:18 UTC.
         I'm running a full reachability check to confirm no other
         endpoints leaked. ETA 2 min.

         I've also opened a follow-up Linear ticket for @alice to
         add a deploy-time test that fails if /api/internal/* is
         reachable without a session cookie. "
```

That's ambient awareness. The agent is on, noticing, reaching out
when something matters. The customer never asked the agent to watch
for this — they didn't have to.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Continuous scanning daemon** | The agent runs scans on schedule (default: daily 03:00 UTC + on every push to main). Engine Phase 13 dep for delta computation; wrapper-side schedule is independent. | M |
| **Drift detection + alert** | The engine emits `continuous_scan_deltas.jsonl`; agent detects new endpoints / regressed findings; posts to Slack + chat. | M (post-engine-13.4) |
| **Real-time KEV banner** | `event_stream.jsonl` from engine PR #219; agent surfaces "new KEV CVE matches your deps" as a chat ping. | S |
| **Behavioural baselines** | `behavioural_baselines.jsonl` from engine Phase 9.2; agent compares this scan vs. baseline, alerts on anomalies ("the response time on /api/users went from 50ms to 800ms today; suspicious"). | S |
| **Trend charts on demand** | "Show me my open-finding trend last 30 days" → agent renders chart inline. Generative UI; no fixed dashboard tab. | M |
| **Autonomous deploy-gate hooks** | Optional: agent runs scans in CI on every PR; blocks merge on critical findings; posts the block reason as a Check Run. | S (post Phase A.5) |

### What's already shipped that carries over

- Realtime channel infra (Supabase realtime) — substrate for "agent
  notices something and posts immediately."
- Coverage banner (PR #64) — when the daily scan can't reach the
  target, agent chats about it: "today's scan against your prod URL
  failed (Vercel returned 500 for 8 min). re-running."

---

## 9. Phase G — Each org gets its own agent

**Engine-team goal:** *"scale to 50+ person companies (Persona 2/3
customers)."*

### Reframe

Multi-tenancy isn't just RLS + RBAC. **Each org has its own agent,
with its own memory.** The agent that talks to Acme Co. knows Acme's
stack, team, decisions, customers, and audit history. The agent that
talks to Beta Inc. is a different agent — same engine, different
memory.

### What the conversation looks like

```
[ Acme's agent ]
You (Acme founder)   " what was the SSRF we found last quarter? "
Strix (Acme agent)   " March 14 — SSRF in /api/import/url, you
                       fixed it by adding an SSRF allowlist. you
                       marked the same issue 'known intentional' on
                       the /api/health endpoint because it's behind
                       VPC. "

[ Beta's agent — same wrapper, different memory ]
You (Beta founder)   " what was the SSRF we found last quarter? "
Strix (Beta agent)   " I haven't been with you that long — only
                       2 weeks. but in that time I haven't seen any
                       SSRF findings. want me to scan for them
                       specifically? "
```

The customer never knows the agent is multi-tenant. Each org
experiences a single, dedicated security engineer with continuous
memory of their company.

### What the wrapper builds for this

| Item | What it is | Effort |
|---|---|---|
| **Per-org agent memory** | New schema: `agent_memory_facts`, `agent_memory_episodes`, `agent_memory_preferences`. Org-scoped via RLS. | M |
| **Memory-aware chat handler** | Every agent message reads from + writes to memory. Powered by retrieval (vector + structured) over the org's history. | L |
| **Per-team sub-agents** | For Persona 2 (50-500 person company): each team can have its own sub-agent that reports to the org agent. Inherits org-level memory; adds team-specific context. | M (post G.1 team layer) |
| **Auditor role** | Read-only "agent shadow" — auditor sees what the agent has seen + done, can't change anything. | S |
| **WorkOS SSO** | Same as the previous roadmap; foundational for enterprise. | L |
| **Stripe billing** | Same as the previous roadmap. Tier flags gate which agent capabilities are enabled (e.g. autopilot needs Pro+; living trust page needs Team+). | L |

### Why agent memory matters

This is the moat. Acme's agent knows that Acme uses Cloudflare WAF
and dismisses certain header findings because of it. The next time
the same finding class lands, the agent doesn't re-flag — but writes
a chat note. **No competing tool has this**, because no competing
tool talks to the customer continuously.

Memory schema (sketch):

```sql
-- migration 052 (after G.1 team layer)
create table public.agent_memory_facts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  scope       text not null,           -- 'stack' / 'team' / 'customer' / 'compliance'
  key         text not null,           -- 'framework' / 'deploy_target' / 'team_lead' / 'auditor_name'
  value       jsonb not null,
  source      text not null,           -- 'inferred_from_repo' / 'told_by_user' / 'derived_from_audit'
  confidence  numeric not null default 1.0,
  superseded_by uuid references public.agent_memory_facts(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, scope, key) where superseded_by is null
);

create table public.agent_memory_episodes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  thread_id   uuid,                     -- chat thread context
  user_id     uuid references auth.users(id),
  agent_action text not null,          -- 'finding_dismissed' / 'fix_applied' / 'scan_run' / 'rule_added'
  payload     jsonb not null,
  rationale   text,                     -- the agent's "why I did this"
  created_at  timestamptz not null default now()
);

create table public.agent_memory_preferences (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  autonomy    jsonb not null default '{}',  -- the slider state
  voice       jsonb not null default '{}',  -- tone / formality / verbosity
  channels    jsonb not null default '{}',  -- which Slack channel for what
  schedule    jsonb not null default '{}'   -- daily-digest time, on-call rotation
);
```

This is *the* data layer change that makes the product feel like a
real engineer rather than a stateless tool.

---

## 10. Phase H — Trust pages as agent portfolios

**Engine-team goal:** *"become the security-credential-display layer
customers use to **sell** to their customers."*

### Reframe

The trust page isn't a marketing brochure. It's the **agent's
portfolio of work** for that customer. The agent maintains it. The
customer's prospects, auditors, and partners visit it. It updates
in real time.

### What it looks like

`https://trust.getedunext.com/`

```
─────────────────────────────────────────────────
 GetEdunext Security
 Maintained by Strix · last updated 4 minutes ago
─────────────────────────────────────────────────

 Continuous monitoring             ✓ active (last scan: 03:00 UTC today)

 Frameworks                        SOC 2 Type 2 — 89% ready (target: Mar 15)
                                   ISO 27001 — 76%

 Last 30 days
 ────────────
 47 issues found                   42 fixed, 5 in progress
 12 KEV CVEs in deps               12 patched within 24h
 0 critical findings open          across 4 services

 Recent improvements (agent-narrated)
 ────────────────────────────────────
 Mar 02 — Patched jsonwebtoken RCE within 4 minutes of CVE
          publication (KEV-listed). Customer was never exposed.

 Mar 14 — Hardened auth middleware mount across all services
          after preventing a regression deploy at 03:14 UTC.

 Mar 21 — Reduced npm dependency footprint by 23% across the
          api repo. Removed 14 transitive deps with known CVEs.

 Verifiable evidence chain
 ─────────────────────────
 Last 30 days of scans signed via run.signature.json (HMAC chain).
 Auditor share-link available on request.

 Want to verify a specific finding's resolution date?
 [ ask the agent ]
─────────────────────────────────────────────────
```

That's a sales tool. The customer's prospects look at this and see a
company with continuous security monitoring, real evidence, and
*narrated improvement* — not a static "we have SOC 2" badge.

### What the wrapper builds for this

| Item | What it is | Effort |
|---|---|---|
| **Living trust page** | Public route, agent-maintained content, auto-updates from `compliance_evidence.json` + finding stats + agent's narrative summaries. | L |
| **Custom-domain trust page** | `trust.<customer>.com` instead of `<org>.trust.strix.io`. DNS verification flow. Custom branding (CSS upload on Enterprise). | L |
| **Agent narrative generator** | After every meaningful event (CVE patch, regression prevented, fix shipped), agent appends a narrative entry to the trust page. | M |
| **Customer-questionnaire automation** | Common questionnaires (SIG / CAIQ / SOC 2 SAQ) — agent pre-fills based on existing evidence. Customer reviews + ships. | L |
| **Insurance-underwriter export** | Pre-formatted PDF for cyber-insurance underwriters. Agent generates on demand. | S |
| **"Prepare for SOC 2" wizard (chat-driven)** | Customer says "prepare me for my SOC 2 audit on Mar 15"; agent generates a remediation plan with milestones, drafts Linear epic, schedules check-ins. | L |
| **Compliance-benchmark feed** | "your security posture is in the top 25% of SaaS your size." Engine Phase 13.2 dep. Privacy-preserving. | M (post-engine-13.2) |

---

## 11. Generative UI components

The new design system. Not a fixed library — a typed schema the
agent emits and the wrapper renders.

### Primitives

| Component | What it renders | Used in |
|---|---|---|
| `<ChatThread>` | The conversation surface. Streaming messages, inline artefacts, suggestions. | Every phase |
| `<AgentMessage>` | One message from the agent. Composed of typed blocks. | Every phase |
| `<AgentArtifact>` | Inline rich content the agent emits — table, chart, diff, code, screenshot, timeline, kanban. | A, B, C, F, H |
| `<AgentSuggestions>` | 1-3 action buttons the agent surfaces beneath each message. | Every phase |
| `<AgentActivityFeed>` | Right-rail showing what the agent did recently — actions auto-taken, pending approvals. | F, G |
| `<FindingThread>` | Sub-thread keyed to a finding_id. Evidence + reasoning + action history. | B |
| `<LivingDoc>` | Markdown / structured doc the agent maintains and the customer reads. | C, H |
| `<AutonomySlider>` | Visualises + edits the per-category, per-severity slider. | E |
| `<CommandPalette>` | Cmd+K — fuzzy search over: actions, findings, scans, threads, docs. Agent-aware (recent prompts at top). | All |
| `<TrustPage>` | Public route, agent-curated. Generative — content blocks change based on what the customer enables. | H |

### Schema for `<AgentMessage>`

```ts
interface AgentMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'agent' | 'system';
  blocks: AgentBlock[];        // typed array of rich content
  citations: Citation[];        // every assertion has a citation
  suggestions?: Suggestion[];   // 1-3 action buttons
  reasoning_trace?: string[];   // collapsed by default; expandable
  confidence?: number;          // 0.0-1.0 for agent claims
  created_at: string;
  acted_on?: AgentAction[];     // record of state changes the agent made
}

type AgentBlock =
  | { type: 'text'; markdown: string }
  | { type: 'table'; columns: string[]; rows: any[][]; caption?: string }
  | { type: 'chart'; kind: 'line'|'bar'|'pie'; data: any; caption?: string }
  | { type: 'diff'; file: string; before: string; after: string; language?: string }
  | { type: 'code'; language: string; content: string; caption?: string }
  | { type: 'screenshot'; url: string; alt: string; caption?: string }
  | { type: 'timeline'; events: { at: string; label: string; evidence?: any }[] }
  | { type: 'finding_ref'; finding_id: string }     // renders as a card
  | { type: 'scan_ref'; scan_id: string }
  | { type: 'pr_ref'; provider: string; url: string; title: string; status: string };
```

Schema is extensible — new block types added as the agent's
capabilities grow. The wrapper renders unknown blocks as collapsed
JSON with a "I don't know how to render this yet" note.

### Real-time streaming

Agent messages stream token-by-token. Blocks resolve as the agent
completes them. The customer sees the agent thinking, not a spinner.

This requires:
- Server-sent events (SSE) channel from the worker → frontend.
- Per-message progressive rendering in `<AgentMessage>`.
- Per-block "loading" state for blocks that take time (e.g. a chart
  block waits for the underlying SQL query).

---

## 12. How this changes the previous PR plan

The previous version of this doc (PR #68 first draft) proposed 45
PRs across phases A-H, structured as "ship the GitHub App + dashboard
+ settings + billing." Most of those PRs are still needed —
**but their priorities and shapes change**.

### What's now urgent

1. **The conversational shell**: `<ChatThread>` + `<AgentMessage>` +
   the SSE stream from the worker. Without this, none of the
   AI-native interactions have a home.

2. **Agent memory**: `agent_memory_facts` + `_episodes` +
   `_preferences` schema. Without memory, the agent feels stateless
   and the product is just a chat-skinned dashboard.

3. **Generative UI artefact schema**: typed blocks the agent emits.
   Without this, the agent is constrained to plain text + canned
   components.

4. **The autonomy slider**: per-category trust state. Without this,
   auto-fix is binary and the customer either trusts everything or
   trusts nothing.

### What gets de-prioritised

- The org-level **compliance dashboard page** (was PR #83) — replaced
  by *agent-mediated compliance Q&A* in chat, with the Living Trust
  Page as the canonical evidence URL. Persona 2 still gets the
  dashboard for filtering, but it's no longer the primary surface.

- **Bulk triage actions** (was PR #76) — replaced by NL triage
  ("dismiss the lows"). Bulk-action UI still useful for power users
  but not the primary path.

- **Trend charts** (was PR #97) — they exist, but they're emitted
  by the agent on demand into chat, not as a fixed dashboard tab.

### What's strictly additive (didn't exist in the previous plan)

- **`<ChatThread>` + streaming + `<AgentMessage>`** — the conversational shell.
- **`agent_memory_*` tables** — multi-tenant per-org agent state.
- **`<AutonomySlider>` + per-org autonomy schema** — calibrated trust.
- **Living-doc primitive** — for SAQ, trust page, runbook, postmortem.
- **Agent-narrated trust page** — Phase H reframed.
- **NL triage handler** + intent parser — Phase B reframed.
- **Per-team sub-agents** — Phase G reframed.

### Revised PR sequencing

Top-priority shift:

| New seq | Phase | Why first |
|---|---|---|
| 1 | **Conversational shell** (new) | Without it, every other phase regresses to the dashboard mental model. |
| 2 | **Agent memory schema** (new) | Without it, the agent feels stateless. |
| 3 | **Phase A — onboarding via conversation** | Replaces the form-based wizard. Required for first-touch. |
| 4 | **`finding_chains.json` ingestion + chat narrative** | The agent's daily digest needs chain-grouped findings. |
| 5 | **Phase B — triage via NL** | Replaces the dashboard inbox as primary. |
| 6 | **`compliance_evidence.json` ingestion + Living SAQ doc** | Compliance becomes a conversation + a living doc. |
| 7 | **Phase D.1 — Slack as agent presence** | Agent's second home. |
| 8 | **Phase E — autonomy slider + auto-fix flow** | Trust calibration unlocks customer scaling. |
| 9 | **Phase F — ambient awareness daemon** | Agent always-on. |
| 10 | **Phase G — multi-tenant agent + WorkOS SSO + Stripe** | Enterprise revenue. |
| 11 | **Phase H — trust pages as agent portfolios** | Sales tool. |

The full original 45-PR set still exists; this reordering puts
AI-native primitives first, then layers traditional surface area on
top.

---

## 13. Implementation specifics

### 13.1 The conversational shell (the foundational primitive)

**Migration 040 (replaces the old GitHub App migration as PR #1):**

```sql
-- chat threads (conversation context)
create table public.agent_threads (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  title       text,                            -- agent-generated; mutable
  context     jsonb,                           -- 'finding_id', 'scan_id', etc.
  created_at  timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  archived    boolean not null default false
);

-- chat messages (typed blocks)
create table public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.agent_threads(id) on delete cascade,
  role        text not null check (role in ('user','agent','system')),
  blocks      jsonb not null default '[]',     -- typed AgentBlock[]
  citations   jsonb not null default '[]',
  suggestions jsonb,
  reasoning_trace jsonb,
  confidence  numeric,
  acted_on    jsonb,                           -- AgentAction[]; null on user messages
  created_at  timestamptz not null default now()
);

-- realtime: subscribe by thread_id
alter publication supabase_realtime add table public.agent_messages;
```

**Worker module:** new `agent_orchestrator.py` — owns the agent's
control loop. Reads user messages; calls the engine for finding
context; calls inference for natural-language responses; writes
agent messages back. Streaming via SSE.

**Frontend:** new `<ChatThread>` component on `/chat` route (and
embedded as a panel on every other page). Subscribes to
`agent_messages` realtime channel. Renders blocks per the
generative-UI schema.

**Effort:** L (~10 days for the foundation; iterations after).

### 13.2 Agent memory schema

Detailed sketch in §9. Three tables: facts (key-value with
provenance), episodes (timeline of meaningful events), preferences
(per-org settings including autonomy slider state).

The agent reads from + writes to memory on every interaction. A
retrieval layer (vector index over episodes; structured query for
facts) selects the relevant context per turn.

**Effort:** M for the schema + retrieval layer; L cumulatively as
each interaction code path learns to read/write memory.

### 13.3 Generative-UI artefact schema

`AgentBlock` typed union (see §11). Frontend renderer is one
component (`<AgentArtifact>`) with a `switch` on block type. New
block types are additive — the wrapper falls back gracefully on
unknown types.

**Effort:** S for the framework; XS per new block type.

### 13.4 Autonomy slider

Per-org `agent_autonomy` JSON column (or its own table for
queryability). NL adjustment handler parses "be more aggressive
with X" → updates slider → confirms in chat. Settings page mirrors
the slider for completeness (and for orgs that prefer to configure
visually).

Pre-action confirmation on critical-severity actions is the safety
default, regardless of slider state. Customer can disable for power
users.

**Effort:** M for the schema + NL handler + settings UI.

### 13.5 Living docs

Generic primitive. Customer-facing URL, content is markdown +
structured blocks, agent maintains it via dedicated tools (`update_living_doc(doc_id, blocks)`). Used by:

- SAQ doc (per framework)
- Trust page
- Security runbook
- Per-incident postmortem

**Effort:** L for the primitive; S per consumer (SAQ / trust page /
runbook / postmortem).

### 13.6 PR-comment renderer + agent-branded output

Same as the previous roadmap — but the bot's voice + comment
template are *the agent's voice*, not a generic "Strix found a bug"
tone. Comment links back to the chat thread for follow-up.

**Effort:** L (unchanged from previous roadmap).

### 13.7 Living trust page

Public route with org-slug URL or custom domain. Agent maintains
the content via the living-doc primitive. Aggregates
`compliance_evidence.json` + finding stats + agent narrative
entries.

Custom-domain support requires DNS verification flow + per-org SSL
provisioning (Cloudflare for SaaS or Vercel custom domains).

**Effort:** L for the public route + content engine; M for custom-domain
provisioning.

### 13.8 Slack as agent presence

OAuth flow + slash commands + bot user that posts proactively. The
bot's identity matches the in-app agent — same name, same voice,
same memory.

Slack-side messages mirror in-app messages: when the agent posts in
chat, the same content lands in Slack (configurable per channel).
Customer can reply in either; the agent threads the conversation
across surfaces.

**Effort:** L (bigger than the previous roadmap's Slack integration
because of the cross-surface conversation threading).

### 13.9 NL triage handler

Backend tool that parses customer messages like "dismiss the lows"
or "fix this" or "snooze this for 30 days" into structured triage
actions. The agent calls this tool via its existing tool-calling
loop.

Implemented as a small classifier + slot-filler over the recent chat
context (the agent already knows what "the lows" refers to from the
preceding message).

**Effort:** M.

---

## 14. Open questions

These complement engine doc §17 + the previous wrapper roadmap §13:

1. **Streaming infrastructure choice.** SSE (works everywhere, single-direction)
   vs. WebSocket (bidirectional, more complex). Probably SSE — agent → user is
   the dominant flow.

2. **Inference cost model for the chat agent.** The conversational shell
   makes its own LLM calls (separate from the engine's pentest agent).
   Per-org budget cap? Per-user? Pass-through pricing on Pro+ tiers?

3. **Memory retention policy.** How long do `agent_memory_episodes` live?
   Forever (cheap, useful)? Sliding 12-month window (privacy default)?
   Per-customer config? GDPR right-to-be-forgotten implications.

4. **Agent name + brand.** The doc uses "Strix" — same as the engine.
   Could rebrand the wrapper-side agent (e.g. "Aegis" or "Sentry") to
   separate engine identity from wrapper identity. Affects positioning.

5. **Multi-modal input.** Voice (customer says "what's my SOC 2 status?")
   reads naturally on mobile. When does that ship?

6. **Agent personality knobs.** Some customers want a terse, all-business
   agent. Others want something warmer. Per-org `voice` preference in
   `agent_memory_preferences`. What's the default?

7. **Engine HTTP API timeline.** The chat agent needs to invoke engine
   scans on demand (not just via the existing subprocess). Engine doc §13
   sketches a future `POST /scans` API. When does that ship?

8. **Dual-surface dashboard sunset.** Today's wrapper (PR #46-#67) has a
   full dashboard for Persona 2 (AppSec engineer). Phases A-H above demote
   it to "secondary." When does it sunset entirely (post Persona 1
   product-market-fit)? Or is Persona 2 a permanent secondary surface?

---

## 15. Tracking

Quarterly review based on customer feedback. The phases here are
*plans, not commitments*. The implementation order in §12 reflects
**maximum customer value per week of engineering time** — not strict
dependency order.

Each phase opens its own tracking PR (mirroring the upstream strix
pattern of using PRs as tracker entries since GitHub Issues are
disabled).

### Documentation cross-references

| Doc | What's there |
|---|---|
| [`README.md`](README.md) | Local development quickstart |
| [`Architecture.md`](Architecture.md) | Tenant-isolation model |
| [`engine-usage.md`](engine-usage.md) | Engine-emit contract |
| [`wrapper-wishlist.md`](wrapper-wishlist.md) | Per-PR rendering specs (older spec; reframed by this doc) |
| [`roadmap.md`](roadmap.md) §19 | Plumbing-tier work (the layer underneath the AI-native UX) |
| [`tools-wishlist.md`](tools-wishlist.md) | Engine PRs the wrapper wants |
| [`usage.md`](usage.md) | Wrapper-product summary; §9 has the Phase A-H gap inventory |
| [`CLAUDE.md`](CLAUDE.md) | Agent guide: doctrine + operational habits |
| [strix `AISecurityEngineer.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineer.md) | Engine roadmap |
| [strix `AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md) | Engine team's wrapper-UX roadmap (the spec this doc proposes implementation for) |

Last updated: 2026-05-06 (rewritten for AI-native interaction model;
supersedes the dashboard-first first draft).
