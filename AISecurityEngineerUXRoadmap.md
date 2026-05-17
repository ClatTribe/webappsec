# `AISecurityEngineerUXRoadmap.md` — wrapper roadmap for a multi-tenant AI-security-engineer endpoint

**Audience:** webappsec contributors. This doc is the wrapper-side
proposal for delivering the engine team's
[`strix/AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md)
phases A-H **as a multi-tenant SaaS endpoint** where many companies
register their assets (repos, web apps, domains, IPs, services) and
Strix continuously analyzes them in a **scalable, per-org-isolated**
manner — with AI-native surfaces (chat, PR comments, Slack, Living
Docs) layered *on top of* that platform.

> **The product shape this doc commits to.** webappsec is an online
> endpoint that thousands of companies will use. Each customer org
> signs up, **registers assets** (GitHub repos, production URLs,
> staging URLs, domains, IPs), and Strix runs continuously against
> that asset inventory — in a sandbox isolated to that org, with
> memory scoped to that org, with findings + compliance evidence
> stored under that org's RLS partition. The product is the
> **platform** (asset inventory + scalable isolated analysis +
> per-org evidence ledger). The AI-native surfaces are how each org's
> people *interact* with their slice of that platform.
>
> **The shift this doc makes (vs. PR #68's first draft).** The
> engine-team's Phase A-H spec reads as a dashboard SaaS. That's
> necessary but not sufficient: the customer (a vibe-coded founder
> who picked Cursor over VS Code because Cursor *talks back*) wants
> the wrapper to *feel* like a security engineer they hired, not a
> form they fill in. So every Phase A-H deliverable here is reframed
> twice: first around the **multi-tenant asset-analysis substrate**
> (the thing that scales), then around the **AI-native interaction
> surfaces** (the thing that delights).

> **Companion to:**
> [`engine-usage.md`](engine-usage.md) (engine-emit contract),
> [`usage.md`](usage.md) (product summary + Phase A-H gap inventory),
> [`roadmap.md`](roadmap.md) §19 (plumbing-tier work),
> [`Architecture.md`](Architecture.md) §1.1 + §3 (tenant-isolation model — the substrate this doc layers on top of),
> [strix `AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md) (the engine team's UX roadmap this doc proposes implementation for).

---

## Contents

0. [The product shape — multi-tenant asset-analysis endpoint](#0-the-product-shape)
1. [The interaction surface — design language for AI-native UX](#1-design-language)
2. [Surfaces — where each org's agent presence lives](#2-surfaces)
3. [Phase A — Org onboarding + asset registration + first analysis](#3-phase-a)
4. [Phase B — Triage as conversation, per-org-isolated](#4-phase-b)
5. [Phase C — Compliance as a living document, per-org ledger](#5-phase-c)
6. [Phase D — Tools the per-org agent uses](#6-phase-d)
7. [Phase E — Autonomy is a slider, per-org-scoped](#7-phase-e)
8. [Phase F — Ambient awareness across each org's asset inventory](#8-phase-f)
9. [Phase G — Scale: thousands of orgs, isolated analysis](#9-phase-g)
10. [Phase H — Trust pages as the org's outward-facing portfolio](#10-phase-h)
11. [Generative UI components — the new design system](#11-generative-ui-components)
12. [How this changes the previous PR plan](#12-how-this-changes-the-pr-plan)
13. [Implementation specifics — schema, routes, components](#13-implementation-specifics)
14. [Open questions](#14-open-questions)

---

## 0. The product shape

### 0.1 What we are building

webappsec is a **multi-tenant SaaS endpoint**. The product is the
combination of:

1. **A multi-tenant asset inventory.** Each customer org signs up,
   creates an org workspace, and registers their assets:
     - GitHub / GitLab / Bitbucket repos (via App install)
     - Web applications (production URL + staging URL + auth recipes)
     - Domains (DNS roots) for surface-mapping
     - Public IPs / IP ranges
     - Cloud accounts (AWS / GCP / Azure account IDs) for posture review
     - Container images / package registries (for SCA + supply chain)
   The same wrapper serves thousands of orgs, each with their own
   asset list, their own findings ledger, their own compliance
   posture, their own people, their own audit log.

2. **Scalable, per-org-isolated analysis.** When an org's asset is
   scanned, Strix runs in a sandbox container that is *isolated to
   that org and that scan*. The sandbox sees only that scan's target,
   only that org's credentials (materialised from the org's Supabase
   vault, never cross-tenanted), and only that org's prior context
   (memory facts, suppression rules, autonomy settings). Many orgs'
   scans run concurrently on the worker fleet without interfering.
   The wrapper is what makes this safe: RLS on every read, vault per
   org, audit log per org, signed evidence chain per scan.

3. **A per-org evidence ledger.** Every finding, every scan event,
   every signed artefact (`vulnerabilities.json`, `coverage.json`,
   `compliance_evidence.json`, `run.signature.json`,
   `finding_chains.json`, `event_stream.jsonl`,
   `behavioural_baselines.jsonl`, `trajectory.jsonl`, SBOM, SARIF) is
   stored under the org's partition. The ledger is *the source of
   truth* the wrapper renders into AI-native surfaces.

4. **AI-native interaction surfaces** — the layer the user sees.
   Chat, PR comments, Slack, Living Docs, Console — these are
   *views into* the platform, each scoped to one org at a time, each
   showing only what that org's user is authorised to see.

The platform is the product. The interaction surfaces are how each
org's people *use* it.

### 0.2 The isolation contract

This is the contract the wrapper guarantees, regardless of which
surface the user is interacting through:

| Dimension | Guarantee |
|---|---|
| **Data** | Every row keyed by `org_id`; RLS enforces `org_id = auth.jwt().org_id`. No cross-org reads. (Architecture.md §3) |
| **Credentials** | Per-org Supabase vault; materialised into the sandbox at scan-start; destroyed at scan-end. Never cross-tenanted. (migration 028 `org_secrets`) |
| **Sandbox** | Each Strix scan = one container, one network namespace, one workdir under `/tmp/strix-runs/<scan_id>/`. The container only sees its own org's target + its own scan budget. |
| **Memory** | The agent's `agent_memory_facts` / `_episodes` / `_preferences` (§9) are RLS-scoped. Acme's agent never reads Beta's facts. |
| **Audit log** | Every state-changing action lands in `audit_log` with `org_id`, `actor`, `action`, `payload`. Per-org auditor share-links query under their own scope. |
| **Evidence chain** | Each scan's artefacts are signed (`run.signature.json` HMAC chain). The signing key is per-org. An auditor verifying Acme's evidence can prove the chain belongs to Acme and only Acme. |
| **Realtime** | Supabase realtime channels filtered by `org_id`. An Acme user's WebSocket subscription cannot see Beta's `agent_messages` or `scan_events`. |

The isolation contract holds whether the surface is chat, PR
comments, Slack, Living Docs, or the API. **A scan kicked off by
Acme can only ever produce findings under Acme's partition. Period.**

### 0.3 What scale looks like at the platform

| Layer | Order of magnitude |
|---|---|
| Orgs onboarded | ~10⁴ (tens of thousands) |
| Assets per org | 1-50 typical, 100s+ for Persona 3 |
| Scans per org per day | 1-10 typical (daily DAST + per-PR + ad-hoc) |
| Concurrent scans, fleet-wide | ~10²-10³ |
| Findings per org over 12 months | 10²-10⁴ |
| AI-surface interactions per org per day | 1-100 (Persona 1: a few; Persona 2: dozens) |
| Per-org isolated sandbox containers | one per running scan |

The wrapper's job is to make **scaling this fan-out invisible** to
each individual user. The org that signed up 4 minutes ago feels
like they have a dedicated security engineer. The platform behind
them is running thousands of orgs concurrently.

### 0.4 What the existing roadmap got right and what it missed

The engine-team's Phase A-H spec got right:
- The GitHub-App-first surface (most orgs land here first).
- The five personas + tier layout.
- The eventual auto-fix flow.
- The compliance-pack handoff.

What was necessary but not sufficient:
- A **dashboard with a findings inbox** is the 2018 model. Each org's
  people don't want to log in and click through 47 issues — they
  want the platform to *surface the two that matter today* via
  whatever surface they live in (PR comment / Slack / chat) and
  *do something about them*.
- A **settings page** is friction for a founder who doesn't know
  what "MFA enforcement attestation" means yet. The platform should
  *infer* the right defaults from the asset inventory and explain
  them in plain language.
- A **scan creation form** treats every scan as a one-off. In a
  multi-tenant SaaS, scans are continuous and asset-triggered: a
  push to a registered repo, a daily schedule against a registered
  URL, a KEV-CVE match against a registered SBOM.
- An **integrations page** is configuration. The org's *agent
  presence* on Slack / Linear / Jira is *one of the surfaces*, not a
  separately-configured product.

### 0.5 The AI-native layer (what makes this not just another DAST SaaS)

Within each org's view of the platform, the user's primary
interaction can be conversation — scoped to their org's asset
inventory and their org's analysis history:

```
[ Alice, founder of GetEdunext (org_id=acme), in their chat panel ]

Alice  " any new issues today? "

Strix  [ scoped to org=acme; reading acme.findings, acme.scan_events,
         acme.agent_memory_episodes ]

       " across your 4 repos and your prod URL —
         2 critical and 3 medium since yesterday's deploy.

         the critical one is interesting:
         someone refactored auth.ts in PR #142 (getedunext-api repo)
         and removed the middleware that checks user.role on
         /api/admin/*. I verified the bug is reachable from
         www.getedunext.com right now.

         I've drafted a fix PR. want to see it? "

Alice  " show me the diff "

Strix  [renders inline diff against acme's repo, plus a regression
        test, plus a CHANGELOG entry]

Alice  " merge it "

Strix  " merged into acme/getedunext-api. I added a test so this
         regression can't recur, and I created a Linear ticket in
         your acme workspace for the team to review the deploy gate.

         the 3 medium findings — all the same dep-CVE class, lodash
         in three of your services. want me to bump them? "
```

Meanwhile, in a different browser, a different org's founder is
having a different conversation about a different asset inventory,
backed by a completely isolated analysis. The platform doesn't blink.

### 0.6 What this doc commits to

1. **The platform is multi-tenant by default; AI-native surfaces are
   layered on top.** Every feature gets a "how does this scale across
   thousands of orgs?" answer before it gets a "what's the
   conversation?" answer.
2. **Conversation is one primary surface among several** (PR
   comments, Slack, Living Docs, Console are co-primary depending on
   persona). Each surface is org-scoped, each shows only the data
   the user's auth context permits.
3. **The agent has memory — per-org.** Acme's "agent" knows Acme's
   stack, Acme's team, Acme's past decisions, Acme's compliance
   landscape. It knows zero about Beta. Memory is just per-org state
   in the platform's data layer.
4. **The agent is proactive — fired by platform events.** New
   `finding.created` in an org's partition → that org's chat /
   Slack / PR comment updates. The user doesn't refresh a dashboard.
5. **The agent acts with calibrated autonomy — per org.** A
   per-org slider (co-pilot ↔ autopilot) per category, per severity.
   Defaults are conservative for new orgs; tunable as trust grows.
6. **The agent shows its work — and the evidence is signed.** Every
   claim is verifiable; the evidence chain is per-org and tamper-
   evident.
7. **Generative UI for the long-tail.** The agent builds the view it
   needs on demand against that org's data.
8. **The dashboard still exists** — as one of several surfaces,
   especially for Persona 2 (AppSec engineer wanting filters + bulk
   actions). Persona 1 (vibe-coded founder) lives in PR comments +
   Slack + chat; the dashboard is a fallback.

---

## 1. Design language

### 1.1 Presence — per-org, across surfaces

Each org has an **agent presence** scoped to that org's people +
that org's asset inventory. The wrapper runs one logical agent per
org (in practice, many concurrent inference sessions, but with
shared per-org memory + autonomy state). The agent's presence shows
up wherever that org's people work:

- **In-app:** persistent chat panel scoped to the active org
  workspace. Never-collapsed by default. Avatar + name (`Strix`) +
  status indicator (idle / thinking / acting / waiting on you).
  Org-scoped data only: switching to a different org in the
  workspace switcher swaps the chat thread, memory, and pending
  actions.
- **In Slack:** a bot user installed into that org's workspace,
  posting in their `#security` channel (or wherever they configured
  it). The Slack install is bound to one wrapper-org; the bot only
  speaks for that org's data.
- **In GitHub:** PR comments and Check Runs from a branded bot,
  posted only on the repos that have been registered to that org.
- **In email:** weekly digest signed by the agent — addressed to that
  org's people, summarising that org's asset analysis.

Within an org, customers feel like *the same engineer* is talking to
them across all surfaces (same name, same voice, same memory). Across
orgs, each conversation is fully isolated.

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

The platform doesn't have *one* interface. Each org's people access
their org's slice through several surfaces. All of them are
org-scoped by auth context (the wrapper enforces `org_id` everywhere
— see Architecture.md §3).

### 2.1 The Chat (in-app)

The default in-app view for the org workspace. Persistent thread with
the agent, plus a sidebar showing "recent threads" (one per finding /
incident / engagement, all within the active org). Cmd+K opens the
command palette for faster nav.

A workspace switcher in the header lets users with access to
multiple orgs (consultants, sub-companies) flip between
**isolated** chat workspaces — each with their own thread history,
memory, autonomy state, and findings ledger.

**What lives here:** every conversation within the org, the latest
digest of *the org's* asset analysis, action buttons (scoped to the
org's permitted actions), generative artefacts the agent renders
inline.

### 2.2 The PR (GitHub)

For each org that has installed the GitHub App on their repos: the
agent reviews every PR. Posts inline comments on findings. Posts a
single Check Run summary. Opens fix PRs with the same bot identity.
Replies to threaded discussion the human reviewer starts.

The PR comment is *the* primary surface for many Persona 1 founders
— they live in GitHub, not in the wrapper's chat. PR comments link
back to the chat thread for follow-up.

**What lives here:** per-PR scan results, fix proposals, threaded
discussion with reviewers, auto-merge-block on critical findings.
All scoped to the org that registered the repo.

### 2.3 The Slack channel

For orgs that installed the Slack app into their workspace: the
agent joins their `#security` channel as a bot user. Posts daily
digests of *that org's* asset analysis. Replies to `@strix`
mentions. Pings that org's on-call engineer for critical findings.
Opens private threads for sensitive discussions.

A wrapper-org maps to one Slack workspace. The bot's identity in a
Slack workspace only carries one org's data.

**What lives here:** team-visible alerts, slash commands, async
discussion that doesn't belong in a PR.

### 2.4 The Living Doc

Some artefacts are documents that *update over time* — and they
need to be addressable by URL so external parties (auditors,
customers, partners) can bookmark them. Per-org URLs:

- `https://trust.<org-slug>.strix.io/` or `https://trust.<custom-domain>/` for the org's trust page
- `https://app.strix.io/o/<org-slug>/saq/soc2-type-2` for the org's SAQ
- `https://app.strix.io/o/<org-slug>/runbook` for the org's runbook

These are not downloads. They are URLs the agent maintains. The
auditor opens the URL today; the agent has updated it since
yesterday's scan; the URL still works. Tamper-evidence: the trust
page surfaces the `run.signature.json` HMAC chain so the auditor
can verify that the evidence belongs to that org and hasn't been
edited post-hoc.

**What lives here:** auditor pack, trust page, security runbook,
SOC 2 SAQ, ISO 27001 SoA, vendor-questionnaire response library.

### 2.5 The Console

The traditional dashboard, scoped to the active org workspace. This
surface is for:

- Persona 2 (AppSec engineer who wants filters + bulk actions)
- Persona 3 (compliance lead reviewing evidence across many scans)
- Auditor share-links (read-only, time-bounded URL into the
  console's evidence views)
- Cases where chat isn't the right modality (visual inspection of a
  kill chain across 50 events, bulk dismissing 200 findings of the
  same fingerprint, etc.)

**What lives here:** findings inbox with filters, asset inventory
view, scan history, team / repo views, raw event timeline, org
settings, billing.

The console is *a tool the agent uses* — when you ask "show me all
auth issues this month," the agent renders a filtered view in chat.
Power users can also navigate the console directly.

### 2.6 The API (additive)

For Persona 3 + 4 (security teams with their own automations): a
per-org REST API. Org-scoped API keys. Same data model as the
console. Every API call writes to the org's audit log. Rate-limited
per org. The chat agent itself can be invoked over this API for
programmatic agent access.

**What lives here:** programmatic access to findings, scan triggers,
evidence-chain verification, autonomy-state updates.

---

## 3. Phase A — Org onboarding + asset registration + first analysis

**Engine-team goal (verbatim):** *"a founder signs up, installs the
GitHub App, and sees their first finding inline on a PR within 5
minutes."*

### Reframe for the multi-tenant endpoint

What's actually happening at sign-up:

1. **A new org workspace gets provisioned** in the platform — a
   `public.organizations` row, an RLS partition, a per-org Supabase
   vault, a per-org signing key for evidence chains, a fresh
   `agent_memory_*` namespace, a default `agent_autonomy` state.
2. **The first user is invited** into that org (as `owner`); future
   teammates join via SSO or invite link.
3. **Assets get registered** — repos via GitHub App install, web
   apps via URL paste, domains via DNS-root entry. Each asset goes
   into `public.scan_targets` (or a new `public.assets` table — see
   §13) keyed by `org_id`.
4. **The platform schedules + runs scans** against the registered
   assets in **isolated sandbox containers** (one container per
   running scan), each materialising only this org's credentials,
   each writing findings only under this org's partition.
5. **Findings stream into the org's surfaces** — chat panel, PR
   comments on the registered repos, Slack if installed.

The user *experience* of all this can still be conversational + low
friction. But what's happening under the hood is the platform
onboarding a new tenant.

### What the user sees (Persona 1, vibe-coded founder)

```
[ Alice lands on app.strix.io, creates an org workspace 'getedunext'
  with email + magic link. Workspace = org_id under the platform's
  RLS partition. ]

Strix  [ in the new workspace's chat panel ]
       " welcome to your getedunext workspace. I'm Strix — I'll
         analyse the code, web apps, and infrastructure you register
         here.

         everything that runs against your assets is isolated to
         this workspace. nothing crosses into anyone else's account.

         to get started I need to know what to look at. you can add
         assets as you go, but the fast path is:

           1. install our GitHub App on the repos you want me to scan
           2. paste your production URL(s) — I'll DAST them daily
           3. (later) domain / IP ranges for surface mapping

         want to start with GitHub? "

Alice  [ clicks 'Install GitHub App' → granted access to 4 repos ]

Strix  " registered 4 repos to your workspace:
           - getedunext-frontend
           - getedunext-api
           - getedunext-admin
           - getedunext-marketing

         I'm queueing a baseline SAST + SCA scan against each.
         each scan runs in its own isolated sandbox; they'll execute
         in parallel as the worker fleet has capacity. ETA for first
         results: ~2-4 minutes.

         while those run, what's your production URL? I'll add it as
         a web-app asset and set up a daily DAST baseline. "

Alice  " https://www.getedunext.com "

Strix  " checked — it's up, served by Vercel, TLS is fine.
         registered as a web-app asset (workspace getedunext).
         scheduled: daily 03:00 UTC + ad-hoc on demand.

         your asset inventory now:
           4 repos (sast+sca, on push)
           1 web app (dast, daily + ad-hoc)
         add more anytime in your console / by asking me.

         first scan results landing —

         repo getedunext-api  → 1 critical SCA: jsonwebtoken@8.5.0
                                 (CVE-2022-23529, KEV-listed RCE).
                                 it's in your auth path.
                                 I drafted a fix PR against that repo.
         repo getedunext-frontend → clean.
         repo getedunext-admin   → 4 medium SCA (lodash, ws, semver, qs).
         repo getedunext-marketing → clean.
         web app www.getedunext.com → first DAST in progress, ETA 3 min.

         the critical matters most. want to see the fix diff? "

Alice  " yes "

Strix  [ renders fix-PR diff inline + linked GitHub PR opened against
         the registered repo, scoped to this org's GitHub App install ]
```

The founder hasn't navigated a settings page, hasn't filled a scan
form, hasn't picked a sandbox size. They've **created an org
workspace, registered 5 assets, and the platform has run 5 isolated
scans in parallel** — surfaced as a conversation.

### What's happening on the platform side (per-org isolation contract)

| Step | Platform action | Isolation guarantee |
|---|---|---|
| Sign up | Create `organizations` row, RLS partition, per-org signing key, per-org vault entry stub | New `org_id` is the partition key for every subsequent row |
| Install GitHub App | Write `github_app_installations` row keyed to `org_id`; store installation token in `org_secrets` (encrypted via the org's vault key) | App install can only ever post to repos that org owns |
| Add web app | Insert `scan_targets` row with `org_id` + `target_kind=web_application` | DNS / reachability check is for that URL only |
| Trigger scan | Enqueue `scan_queued` notify; worker claims; spawns sandbox container in network namespace isolated to that scan | Container env vars + mounted dir contain only this scan's creds + workdir |
| Stream findings | Engine emits `finding.created` → wrapper writes to `findings` with `org_id` → realtime channel filtered by `org_id` → only this org's users see it | RLS + realtime filter |
| Sign evidence | `run.signature.json` HMAC chain uses the org's signing key | Auditor verifying the chain can prove it belongs to this org |

### What the wrapper builds for Phase A

| Item | What it is | Effort |
|---|---|---|
| **Org workspace provisioning** | On sign-up: create `organizations` row, RLS partition, per-org vault namespace, per-org signing key, default `agent_autonomy` state, seeded `agent_memory_preferences`. | M (partial — RLS already exists) |
| **Conversational onboarding flow** | One screen, chat-style. Explains the workspace/isolation model in plain language. Agent asks ~3-4 questions to seed memory, infers the rest from registered assets. | M |
| **Asset-registration primitives** | First-class `public.assets` table (or extension of `scan_targets`) with rich metadata: kind, identifier, owning team, schedule, last scan, current posture. The console's asset-inventory view + the chat agent both read from this. | M |
| **Repo / stack inference** | After GitHub App install, worker reads `package.json` / framework markers across each registered repo, writes to `agent_memory_facts` per repo + per org. | S |
| **Per-asset auto-scheduling** | Each new asset registration enqueues an immediate baseline scan + sets up its recurring schedule (daily for web-apps, on-push for repos). Workers claim per-org with fair-share. | M |
| **Concurrent fan-out** | Worker pool runs N scans simultaneously across orgs; each scan in its own sandbox. Per-org concurrency cap (default 4) so a noisy org can't starve others. | M (partial — single-worker exists) |
| **Live findings stream into the org's chat** | As the engine emits `finding.created`, the wrapper writes to `findings` (org-scoped), then the agent composes a chat message — *"I found X in your getedunext-api repo. it matters because Y. want me to do Z?"* | M |
| **PR-comment renderer** (engine A.5) | Same as the previous roadmap. PR comments posted via the GitHub App install scoped to that org's permission. Comment links back to the chat thread under that org. | L |
| **GitHub App install + multi-repo registration** | One install can register many repos under the same org. Customer can later add / remove repos without re-installing. | M |
| **Web-app capture as conversation step** | Agent asks; founder pastes; agent validates + creates an `asset` row + enqueues first DAST. No separate form. | XS |
| **Agent voice + system prompt** | System prompt + tone guide. Org-aware (substitutes org name, asset names, registered targets). Same name, same voice across all surfaces *within an org*. | XS |

### Acceptance criteria

- Time-to-first-finding < 5 min from sign-up.
- The first finding lands in *every* surface the org has enabled:
  in-app chat, PR comment (if repo asset), Slack (if installed).
- The customer never sees data from any other org — workspace
  switcher, queries, realtime channels are all RLS-scoped.
- Sign-up of a new org succeeds in < 30 s end-to-end (provisioning
  + first scan-queued event) under load (10 concurrent sign-ups).
- A scan kicked off by org A and a scan kicked off by org B run in
  fully isolated sandboxes; both succeed within their own SLA.

### What's already shipped that carries over

- Multi-tenant org schema + RLS + audit_log — **the foundation
  this whole roadmap stands on**. (Architecture.md §3)
- Per-org vault for credentials (migration 028) — extends to the new
  per-org signing key.
- Engine PR #29 preflight — the "is your URL reachable?" check
  per registered asset.
- Coverage banner (PR #64) — when the daily scan against the org's
  registered URL can't reach it, the agent + the trust page both
  say so honestly.
- Subprocess + events.jsonl tailer infra in `strix_worker` — the
  per-scan isolated execution path.

### New components needed

- `<ChatThread>` — surface for the org's chat. Streaming response,
  inline artefacts, citations, suggestions row. Realtime
  subscription filtered to the active org.
- `<AgentMessage>` — composed of typed blocks (see §11).
- `<AgentSuggestions>` — 1-3 action buttons beneath each message,
  filtered to actions the active user is authorised for in this org.
- `<WorkspaceSwitcher>` — header dropdown for users with access to
  multiple orgs. Switching swaps chat thread, asset inventory,
  findings ledger, autonomy state — all org-scoped.
- `<OnboardingChat>` — variant of `<ChatThread>` for the first-run
  experience of a freshly-provisioned org. Pre-seeded with the
  agent's introduction explaining the isolation model.
- `<AssetInventoryPanel>` — sidebar / page showing the org's
  registered assets (repos, web apps, domains, IPs), current
  posture, last scan time, scheduled next scan.

---

## 4. Phase B — Triage as conversation, per-org-isolated

**Engine-team goal:** *"customers spend < 1 minute per finding to
triage; false-positive rate < 10%."*

### Reframe

In a multi-tenant SaaS, "triage" is **one org's view of one org's
findings** rendered into whichever surface that org's user is on
(chat / PR / Slack / console). The platform is producing findings
across thousands of orgs concurrently; each user only ever sees
their own.

The agent's daily digest is composed by reading **the active org's
findings table joined to that org's asset inventory** — never
across orgs. The NL triage handler updates **that org's**
suppression rules + autonomy state, scoped by `org_id` on every
write.

### What the conversation looks like (Alice's view of acme's findings)

Daily digest in Alice's chat panel (and acme's Slack `#security`
channel if installed):

```
Strix  " yesterday's scans across your getedunext workspace —
         12 issues across 3 of your 4 repos + 1 on your prod URL:
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
"recently dismissed" view. The user responded in natural language;
the platform did the right things in their org's partition, learned
the suppression rule **for that org**, and the rule applies to
future scans of *that org's* assets only.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Daily digest as chat post** | Agent composes a digest after the daily scan; posts to chat + Slack. Group by exploit chain (engine `finding_chains.json`), explain in plain language, surface the 1-2 things that matter. | M |
| **Per-finding chat thread** | Click a finding in the digest → opens a sub-thread with that finding's evidence, the agent's reasoning, action buttons. Persists across sessions. | M |
| **NL triage actions** | "dismiss the lows" / "fix the critical" / "snooze for 30 days" — agent parses intent, applies action, confirms. Same NL handler covers all triage shortcuts. | L |
| **Suppression rule learning** | When the user dismisses a class with a reason ("we have Cloudflare WAF"), the platform stores it as a per-org suppression rule (`agent_memory_facts` scope='suppression', `org_id` keyed). Next scan against *that org's* assets, the agent doesn't re-flag — but writes a chat note: "I would have flagged X but your Cloudflare WAF rule covers it." Other orgs are unaffected. | M |
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

## 5. Phase C — Compliance as a living document, per-org ledger

**Engine-team goal:** *"replace Vanta/Drata for security-finding
evidence collection."*

### Reframe

Each org has its own compliance posture. The platform aggregates
**that org's** `compliance_evidence.json` across **that org's**
scans, signs the chain with **that org's** key, and renders the
result into living URLs that **that org** can share externally
(auditor share-link, trust page, customer-questionnaire response).

A SOC 2 readiness number for acme is computed only over acme's
assets + acme's scan history. The same SOC 2 framework, evaluated
against beta's assets, gives beta a different number. Each is
isolated.

### What the conversation looks like

```
You    " how ready am I for SOC 2 Type 2? "

Strix  " for the getedunext workspace, right now:
           SOC 2  : 89% ready — 11 of 12 controls passing
           ISO 27001 : 76% — needs 4 more controls
           PCI DSS : N/A (no payment data flow detected in your assets)

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

## 6. Phase D — Tools the per-org agent uses

**Engine-team goal:** *"meet customers where they are. Slack, Linear,
Jira, GitHub annotations."*

### Reframe

Each org has its own Slack workspace, its own Linear team, its own
Jira project, its own GitHub org. The wrapper installs the org's
*agent presence* into each of those, scoped to that org's data only.

From the org's perspective: "the agent uses Slack / Linear / Jira"
— meeting the team where they live. From the platform's perspective:
**per-org OAuth tokens stored in the per-org vault, per-org bot
identity, per-org cross-tool action audit log.** A wrapper-org maps
one-to-one to a Slack workspace install, a Linear OAuth grant, etc.

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
conversation context (this org installed Slack; they have a
`#security` channel; that's where this kind of thing belongs).

Behind the scenes: the Slack bot, when posting, is acting under that
org's install. The Slack message it generates pulls from that org's
findings only. The Linear ticket it creates uses that org's Linear
OAuth grant.

### What the wrapper builds for this conversation

| Item | What it is | Effort |
|---|---|---|
| **Slack as a presence** | Per-org Slack install. OAuth grant + bot token stored in that org's vault. The bot only posts that org's findings + only replies in that org's workspace. | L (was PR #89) |
| **Linear / Jira as agent tools** | Per-org OAuth grant. When the agent decides "this needs a ticket," it creates one in the org's Linear / Jira project, calibrated by that org's autonomy slider. | M each (PR #90, #91) |
| **GitHub Code Scanning as agent surface** | Per-org GitHub App permissions cover SARIF upload to the org's repos. Agent's PR comments reference the GitHub Security tab where applicable. | S |
| **Generic outbound webhook** | For the org's custom internal tool (Datadog / PagerDuty / homegrown). Per-org webhook URL + signing secret. Agent calls it when configured. | S |
| **Public REST API + per-org keys** | Per-org API keys (created in the org's settings). Every API call is org-scoped via the key. Programmatic agent invocation = "this org wants the agent to do X." | M |
| **CI integration packs** | GitHub Actions composite action — published. Each org's CI run authenticates with that org's API key + posts findings to that org's partition. | S |

The wrapper *exposes* these as configurable, but the customer's
mental model is **"the agent uses these tools"**, not "I have
integrations." The wrapper's responsibility: keep per-org tool
credentials encrypted and never cross-tenant the bot identity (the
Slack bot speaking in Acme's workspace cannot, by construction,
post Beta's data).

### What's already shipped that carries over

- Slack webhook (PR #62) — becomes the entry point for proper
  Slack-app upgrade.
- CI snippet generator (PR #57) — becomes the published GitHub
  Actions composite.
- Audit log infra — every agent action via these tools writes an
  `audit_log` entry.

---

## 7. Phase E — Autonomy is a slider, per-org-scoped

**Engine-team goal:** *"customers click 'Apply Fix' on a PR comment
and get a fix PR opened automatically."*

### Reframe

Each org has its own autonomy state — its own appetite for letting
the agent act without asking. Acme can be in autopilot for
dep-CVEs; beta can require confirmation on everything. The platform
stores this per-org in `agent_autonomy` (column on
`agent_memory_preferences`), reads it on every proposed action, and
enforces it in the action handler.

"Apply Fix" as a one-time button click is the basic case. The bigger
unlock is **the per-org autonomy slider** (§1.6). Once an org trusts
the agent on a category, they don't want to click "Apply Fix" 47
times — they want to say "you fix critical and high autonomously,
ask me on medium." That decision is bound to that org's policy.

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

## 8. Phase F — Ambient awareness across each org's asset inventory

**Engine-team goal:** *"customers see their security posture trend in
real-time, alerted on regressions."*

### Reframe

Trend dashboards are a *fallback*. The default is the platform
**noticing changes against an org's asset inventory and reaching
out to that org's people**.

The continuous-scanning daemon runs across all registered assets,
fleet-wide, with per-org concurrency caps so a noisy org can't
starve others. Drift detection compares the latest scan's surface
map against the org's stored baseline. When drift is detected, the
alert lands in *that org's* Slack channel + chat — not the
platform's. Each org sees only their own drift.

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

## 9. Phase G — Scale: thousands of orgs, isolated analysis

**Engine-team goal:** *"scale to 50+ person companies (Persona 2/3
customers)."*

### Reframe

This is the phase where the multi-tenant SaaS endpoint shape really
shows up. The platform must support:

- **Thousands of concurrent orgs**, each with their own asset
  inventory, scan history, findings ledger, compliance posture,
  memory, autonomy state, team members, billing.
- **Strict per-org isolation** at every layer — data (RLS),
  credentials (per-org vault), execution (per-scan sandbox),
  memory (RLS), audit log (per-org), evidence chain (per-org
  signing key), realtime (filtered channels), Slack/Linear/Jira/
  GitHub identity (per-org install).
- **Scalable execution** — many scans running in parallel across
  the worker fleet, fair-share across orgs, no noisy-neighbour
  starvation, per-org cost-cap enforcement.
- **Per-org enterprise primitives** — SSO, RBAC across roles
  (`owner`, `admin`, `member`, `viewer`, `auditor`), per-team
  sub-scopes, billing, contract-level retention.

The user-visible promise: **each org's people experience a single
dedicated security engineer with continuous memory of their
company.** They never see the platform's multi-tenancy. The fact
that 10,000 other companies share the same fleet of workers is an
implementation detail the wrapper hides.

### What the user notices (or doesn't)

```
[ Acme's chat workspace, Alice ]
Alice (Acme)   " what was the SSRF we found last quarter? "
Strix          " March 14 — SSRF in /api/import/url on your
                 acme-api repo, you fixed it by adding an SSRF
                 allowlist. you marked the same issue 'known
                 intentional' on the /api/health endpoint because
                 it's behind VPC. "

[ Beta's chat workspace, Bob, on the same wrapper deployment ]
Bob (Beta)     " what was the SSRF we found last quarter? "
Strix          " I haven't been with your workspace that long —
                 only 2 weeks. but in that time I haven't seen any
                 SSRF findings against your registered assets. want
                 me to scan for them specifically? "
```

Two different orgs, two different memories, two different asset
inventories, two different chat threads, two different signing
keys — one platform.

### Per-org isolation: where it lives in the stack

| Layer | Per-org primitive |
|---|---|
| Database | RLS policies on every table keyed by `org_id = auth.jwt().org_id` |
| Storage (`scan-artifacts`, `evidence`) | Object path includes `org_id/`; bucket policies enforce `auth.jwt().org_id` prefix |
| Vault | `org_secrets` with per-org encryption key derived from the platform KMS |
| Worker fleet | Per-org concurrency cap; fair-share queue; cost-cap-per-org enforced before scan-claim |
| Sandbox containers | One per scan; ephemeral; only that scan's creds materialised; destroyed at scan-end |
| Memory | `agent_memory_*` RLS-scoped |
| Audit log | `audit_log` rows keyed by `org_id`; auditor share-links filter to one org |
| Evidence signing | Per-org signing key (KMS-derived) used for `run.signature.json` HMAC chain |
| Realtime | Supabase realtime channels filtered to `org_id` |
| Slack / GitHub / Linear / Jira | Per-org OAuth grant + install; bot identity bound to one org per workspace |

### What the wrapper builds for Phase G

| Item | What it is | Effort |
|---|---|---|
| **Per-org agent memory** | Tables: `agent_memory_facts`, `agent_memory_episodes`, `agent_memory_preferences`. RLS-scoped by `org_id`. (Schema sketch below.) | M |
| **Memory-aware chat handler** | Every chat-agent turn reads + writes the active org's memory only. Retrieval layer (vector index over the org's episodes; structured query for facts). | L |
| **Per-team sub-scopes** | For Persona 2/3 orgs: teams as sub-scopes under `org_id`. Findings tagged by team; team-level autonomy state inherits from org defaults. | M |
| **RBAC** | Five roles: owner, admin, member, viewer, auditor. Enforced at every API endpoint + UI route. Audit log captures `actor_role`. | M |
| **Per-org fair-share worker scheduler** | Queue claim respects per-org concurrency cap (default 4 simultaneous scans); no org can starve the fleet. Cost-cap-per-org enforced before scan-claim. | M |
| **Per-org signing keys** | Each org's `run.signature.json` HMAC chain uses an org-specific key (KMS-derived). Auditor verifies the chain belongs to that org. | S |
| **WorkOS SSO** | Per-org SSO config (Google Workspace / Okta / OneLogin / Microsoft). | L |
| **Stripe billing** | Per-org subscription. Tier flags gate which platform features are enabled (autopilot needs Pro+; living trust page needs Team+; per-team sub-scopes need Enterprise). Cost-cap-per-org defaults from tier. | L |
| **Per-org retention** | Configurable retention windows for `findings`, `scan_events`, `agent_memory_episodes`. Enterprise tier can set per-asset retention. | M |
| **Org-level audit-log export** | Auditor / compliance lead can export the org's `audit_log` for a date range. Signed manifest. | S |

### Why per-org memory matters

This is the moat. Acme's slice of the platform knows that Acme uses
Cloudflare WAF and dismisses certain header findings because of it.
The next time the same finding class lands against Acme's assets,
the agent doesn't re-flag — but writes a chat note. The same scan
against Beta's assets *does* flag, because Beta has no such
suppression. **No competing tool can do this**, because no competing
tool combines continuous scanning of an org's asset inventory with
continuous conversation with that org's people.

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

## 10. Phase H — Trust pages as the org's outward-facing portfolio

**Engine-team goal:** *"become the security-credential-display layer
customers use to **sell** to their customers."*

### Reframe

Each org gets a public URL — their trust page — backed by **their
org's evidence chain**. The agent maintains it. The org's
prospects, auditors, and partners visit it. It updates in real time
from that org's continuous scanning.

The page is one of the org's living-doc surfaces (§2.4). The
content is rendered from that org's `compliance_evidence.json`
aggregated across that org's scans + that org's finding stats +
narrative entries the agent appended after each meaningful event.
The signing chain proves the evidence belongs to that org and
hasn't been edited post-hoc.

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

0. **Multi-tenant scale plumbing (§13.10) + asset inventory table
   (§13.0)**. The SaaS endpoint cannot safely take external traffic
   without `auth.jwt_org_id()`, per-org signing keys, fair-share
   scheduler, realtime-filter audit, and a first-class `assets`
   registry. This sits under everything else.

1. **The conversational shell**: `<ChatThread>` + `<AgentMessage>` +
   the SSE stream from the worker, org-scoped from day one. Without
   this, none of the AI-native interactions have a home.

2. **Per-org agent memory**: `agent_memory_facts` + `_episodes` +
   `_preferences` schema, RLS-scoped. Without memory, the agent feels
   stateless and the product is just a chat-skinned dashboard.

3. **Generative UI artefact schema**: typed blocks the agent emits.
   Without this, the agent is constrained to plain text + canned
   components.

4. **The per-org autonomy slider**: per-category trust state stored
   per org. Without this, auto-fix is binary and the org either
   trusts everything or trusts nothing.

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

Top-priority shift — the multi-tenant substrate first, then the
AI-native interaction layer, then the surfaces:

| New seq | Phase | Why first |
|---|---|---|
| 0 | **Multi-tenant scale plumbing (§13.10)** | The SaaS endpoint can't safely accept external orgs without `auth.jwt_org_id()`, per-org signing keys, fair-share scheduler, realtime-filter audit, org-deletion contract. Most items are S individually. |
| 1 | **Asset inventory as first-class table (§13.0)** | Every other phase reads `assets`. Today's `scan_targets` is per-scan; the platform needs a registry. |
| 2 | **Conversational shell** (new) | Without it, every other phase regresses to the dashboard mental model. Org-scoped from day one. |
| 3 | **Per-org agent memory schema** (new) | Without it, the agent feels stateless. Org-scoped via RLS. |
| 4 | **Phase A — org onboarding + asset registration + first analysis** | Replaces the form-based wizard. Required for first-touch. |
| 5 | **`finding_chains.json` ingestion + chat narrative** | The agent's daily digest needs chain-grouped findings, per org. |
| 6 | **Phase B — triage via NL** | Replaces the dashboard inbox as primary, per org. |
| 7 | **`compliance_evidence.json` ingestion + Living SAQ doc** | Compliance becomes a conversation + a living doc, per org. |
| 8 | **Phase D.1 — per-org Slack install** | Agent's second home, per org. |
| 9 | **Phase E — autonomy slider + auto-fix flow** | Per-org trust calibration unlocks customer scaling. |
| 10 | **Phase F — continuous scanning fleet + drift detection** | Asset-inventory-driven always-on. |
| 11 | **Phase G — RBAC + WorkOS SSO + Stripe + per-team sub-scopes** | Enterprise revenue. |
| 12 | **Phase H — per-org trust pages** | Sales tool. |

The full original 45-PR set still exists; this reordering puts the
multi-tenant substrate underneath, the AI-native primitives in the
middle, and the surfaces on top.

---

## 13. Implementation specifics

### 13.0 Asset inventory as a first-class table

The platform's center of gravity is the per-org asset inventory.
Today's `scan_targets` table is per-scan; what's needed is a
**registry** (the org's continuously-monitored inventory) that
scans run *against*.

**Migration 040 — `public.assets`:**

```sql
create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  kind          text not null check (kind in (
                  'repository','web_application','domain','ip_range',
                  'cloud_account','container_image','package_index'
                )),
  identifier    text not null,                 -- repo full name / URL / DNS root / CIDR / cloud account id
  display_name  text,
  owning_team   uuid references public.teams(id) on delete set null,
  schedule      jsonb not null default '{}',   -- {kind:'daily',time:'03:00Z'} | {kind:'on_push'} | {kind:'manual'}
  metadata      jsonb not null default '{}',   -- framework hints, auth recipes, allowlists, severity overrides
  posture       jsonb,                         -- latest summary {critical,high,med,low,coverage_percent,last_scan_at}
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (org_id, kind, identifier) where archived_at is null
);

alter table public.assets enable row level security;
create policy "assets are org-scoped" on public.assets
  for all using (org_id = auth.jwt_org_id());

create index assets_org_kind on public.assets (org_id, kind) where archived_at is null;
```

Every scan references an asset; every finding has both `org_id` and
`asset_id`. The chat agent's daily digest reads `assets` joined to
`findings`. The console's primary view (for Persona 2) is the asset
inventory.

### 13.1 The conversational shell (foundational primitive)

**Migration 041 — chat threads + messages, org-scoped:**

```sql
-- chat threads (conversation context, per-org)
create table public.agent_threads (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  title       text,                            -- agent-generated; mutable
  context     jsonb,                           -- 'finding_id', 'scan_id', 'asset_id'
  created_at  timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  archived    boolean not null default false
);

alter table public.agent_threads enable row level security;
create policy "threads are org-scoped" on public.agent_threads
  for all using (org_id = auth.jwt_org_id());

-- chat messages (typed blocks)
create table public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.agent_threads(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  role        text not null check (role in ('user','agent','system')),
  blocks      jsonb not null default '[]',     -- typed AgentBlock[]
  citations   jsonb not null default '[]',
  suggestions jsonb,
  reasoning_trace jsonb,
  confidence  numeric,
  acted_on    jsonb,                           -- AgentAction[]; null on user messages
  created_at  timestamptz not null default now()
);

alter table public.agent_messages enable row level security;
create policy "messages are org-scoped" on public.agent_messages
  for all using (org_id = auth.jwt_org_id());

-- realtime: subscribe by org_id, filtered server-side via RLS
alter publication supabase_realtime add table public.agent_messages;
```

The `org_id` is duplicated on `agent_messages` (denormalised from
the thread) so realtime filters can run without join — every
WebSocket subscription resolves on `org_id = auth.jwt_org_id()`,
guaranteeing no cross-tenant leakage in the realtime layer.

**Worker module:** new `agent_orchestrator.py` — owns the chat
agent's control loop. Resolves the active org from the user's JWT,
then operates strictly within that org's partition: reads user
messages, queries that org's findings + asset inventory + memory,
calls inference for natural-language responses, writes agent
messages back. Streaming via SSE. **The orchestrator never holds a
service-role connection across orgs in a single request** — every
DB call uses the user's JWT so RLS is the second line of defence.

**Frontend:** new `<ChatThread>` component on `/o/<org-slug>/chat`
route (and embedded as a panel on every other org-scoped page).
Subscribes to the org-filtered `agent_messages` realtime channel.
Renders blocks per the generative-UI schema. `<WorkspaceSwitcher>`
remounts the chat surface when the active org changes — no shared
state across orgs in the client either.

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
actions, scoped to the active org. The agent calls this tool via
its existing tool-calling loop.

Implemented as a small classifier + slot-filler over the recent chat
context (the agent already knows what "the lows" refers to from the
preceding message). The resulting writes go through the org's RLS
context — a user cannot dismiss findings in any org other than the
one in their active JWT.

**Effort:** M.

### 13.10 Multi-tenant scale plumbing

Things the platform needs to deliver Phase G:

| Item | What it is | Effort |
|---|---|---|
| **`auth.jwt_org_id()` helper** | Postgres function reading `org_id` from the JWT claim; used by every RLS policy. Plus a `set_active_org(org_uuid)` RPC that lets a multi-org user switch context — emits an `audit_log` row on every switch. | S |
| **Per-org signing key in KMS** | KMS-derived per-org HMAC key for `run.signature.json`. On org create: derive + cache; on scan-end: sign artefacts. Key rotation per org without losing prior chain. | M |
| **Fair-share worker scheduler** | Replace today's FIFO queue with weighted-fair-queueing keyed by `org_id`. Default per-org concurrency cap = 4. Per-org cost-cap-per-day enforced at claim time. | M |
| **Per-org rate-limit on chat agent inference** | LLM-call budget per org per day. Defaults from billing tier. Hard cap with grace + soft cap with chat warning. | S |
| **Realtime channel filter audit** | Sweep every Supabase realtime publication to confirm RLS-filtered subscription works. Test: subscribe as user-from-orgA; verify zero rows from orgB land in the channel. | S |
| **Per-org storage path enforcement** | `scan-artifacts` and `evidence` buckets accept writes only under `<org_id>/<scan_id>/...`. Bucket policy enforces `auth.jwt_org_id()` prefix on every read + write. | S |
| **Sandbox container teardown discipline** | Every scan container destroyed on scan-end (success, failure, cancel, budget-exceeded). Sweep job to reap orphans. Verify per-scan: no shared volume across scans. | S |
| **Org-deletion contract** | When an org is deleted: cancel running scans, delete all rows across all per-org tables in a single transaction (RLS cascade), revoke per-org secrets in vault, revoke OAuth tokens, mark per-org signing key for crypto-shredding. Right-to-be-forgotten compliance. | M |
| **Per-org audit-log retention + export** | Retention windows + signed exports. (Already partially shipped — extend.) | S |

These items are **non-negotiable for opening the SaaS endpoint to
external customers**. They sit underneath every other phase: A-H
above all assume this plumbing is solid.

**Effort:** M cumulatively; most items are S individually.

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

Last updated: 2026-05-11 (reframed around the multi-tenant SaaS
endpoint shape — many orgs registering assets and getting analysed
in scalable, per-org-isolated sandboxes, with AI-native surfaces
layered on top; supersedes the AI-native-only second draft that
under-emphasised the multi-tenant substrate).
