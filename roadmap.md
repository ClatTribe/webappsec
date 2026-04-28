# Roadmap

Where this project is going. The list below covers improvements to the **wrapper itself** — the multi-tenant SaaS layer that sits on top of Strix. Strix-engine work is intentionally out of scope; that's tracked at [`usestrix/strix`](https://github.com/usestrix/strix).

Read this alongside [`Architecture.md`](Architecture.md), which explains the design decisions and isolation model behind the items below.

---

## Positioning

This is a **product-led growth (PLG) platform** for **medium-sized businesses** (roughly 50–500 employees, 5–50-person dev team). The buyer is usually an appsec engineer or a security-minded staff engineer, not a CISO with a procurement process. The product has to:

- **Activate in under 10 minutes** from signup → first real finding.
- **Be self-serve end-to-end** — no sales calls, no demos required.
- **Work out of the box** with sane defaults for the asset types these teams actually have:
  - **GitHub repositories** — primary use case. White-box scans on PR or schedule.
  - **Deployed web apps** — staging or prod URLs.
  - **Domains** — pre-deploy CT enumeration and surface mapping.
  - **IPs / IP ranges** — for teams running their own infra.
  - **Local code paths** — for the security-minded dev who installs locally.
- **Convert bottoms-up**: a single dev tries it on one repo → invites their team → the org pays.
- **Have viral surface**: shareable findings, embeddable scan badges, a one-line GitHub Action.

That ICP shapes the priorities below. Enterprise items (SSO, SCIM, SAML, K8s-Job-per-scan, air-gap) are listed but explicitly **deferred** — they belong in a later motion once the PLG funnel is proven.

---

## Status legend

| | meaning |
|---|---|
| ✅ | shipped — already on `main` |
| 🚧 | partial — in flight or rough mitigation in place |
| ⬜ | open — not started |

Effort estimates: **S** ≈ a day, **M** ≈ a week, **L** ≈ a month, **XL** ≈ a quarter.

---

## Table of contents

1. [Ship-blockers](#1-ship-blockers)
2. [Public marketing site](#2-public-marketing-site)
3. [Out-of-the-box & first-run](#3-out-of-the-box--first-run)
4. [Activation & time-to-value](#4-activation--time-to-value)
5. [Free → paid conversion](#5-free--paid-conversion)
6. [Retention loops](#6-retention-loops)
7. [Viral & share surface](#7-viral--share-surface)
8. [CI/CD plumbing](#8-cicd-plumbing)
9. [Target coverage for SMB](#9-target-coverage-for-smb)
10. [Triage & remediation](#10-triage--remediation)
11. [SOC 2 / ISO-light compliance](#11-soc-2--iso-light-compliance)
12. [Ops & reliability](#12-ops--reliability)
13. [Security hardening](#13-security-hardening)
14. [Quality & contributor experience](#14-quality--contributor-experience)
15. [Deferred — enterprise motion](#15-deferred--enterprise-motion)
16. [Future / research](#16-future--research)
17. [Already shipped](#17-already-shipped)

---

## 1. Ship-blockers

Gaps that make the system feel half-built. Close these before anyone outside the team relies on it.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Stream `events.jsonl` live**, not just at scan exit. The structured agent graph only appears post-exit; users see raw stdout for the duration. | A 30-min scan with no UI feedback feels broken. | [`runner.py:165-190`](webapp/worker/src/strix_worker/runner.py#L165) — tail the file as Strix writes it, route through `worker_insert_scan_event`. | M |
| ⬜ | **Populate token / cost stats.** Currently zero on every finished scan. | Required for cost caps, billing, plan enforcement (§4). Without this, the entire monetization path is blocked. | [`supabase_client.py:46-50`](webapp/worker/src/strix_worker/supabase_client.py#L46), `runner._upload_run_artifacts`. | S |
| ⬜ | **Scan-cancel button.** No way to stop a runaway scan. | Cost control + trust. PLG users don't tolerate "this is going to charge you something, you can't stop it". | New: `POST /api/scans/[id]/cancel` → SIGTERM the subprocess + stop the sandbox. | M |
| ⬜ | **Atomic scan claim.** Two workers can both try to dispatch the same `scan_queued` notification today. | Prevents duplicate scans + doubled cost when the worker pool scales. | Replace LISTEN-then-update with `SELECT … FOR UPDATE SKIP LOCKED`, or add a `claimed_by` column. | S |
| ⬜ | **Stuck-scan recovery.** If Strix hangs (we hit this with Gemini Pro rate-limiting), the scan stays `running` forever and silently keeps consuming a worker slot. | Operator hygiene + free-tier abuse prevention. | Add `scans.last_heartbeat_at`, worker writes it every minute while running, periodic sweep marks scans stale. UI surfaces stuck scans with a manual reset. | S |

---

## 2. Public marketing site

Pre-signup top-of-funnel. Every page below lives at a public route on the same Next.js app (or a sibling deployment) and feeds traffic into signup. Content for these pages is also reused inside the in-app help (§3) so we don't write things twice.

All of these are static-friendly and a good fit for **MDX in `app/(marketing)/`** with `next/mdx`. Set up once, ship per-page in a few hours.

### Required for launch

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **`/pricing`** | The first thing every PLG comparison shopper checks. Three tiers (Free / Team / Business), self-serve "Upgrade" button, FAQ block. | `app/pricing/page.tsx`. Style-matches the landing. | S |
| ⬜ | **`/privacy`** | Legally required (GDPR / CCPA / DPDP). | `app/legal/privacy/page.tsx` (MDX). | S |
| ⬜ | **`/terms`** | Required to charge money. | `app/legal/terms/page.tsx` (MDX). | S |
| ⬜ | **Cookie consent banner.** | Required for EU traffic. Honor `Do-Not-Track`. | New: `components/cookie-banner.tsx` + `cookies-policy` page. | S |
| ⬜ | **`/security` (a.k.a. `/trust`)** | Public security posture: how we encrypt secrets, isolate tenants, where data is stored, our own SOC 2 status. The page that shortens an SMB security review from 30 days to 1. | New: `app/security/page.tsx`. Pulls heavily from [`Architecture.md`](Architecture.md) §3. | S |
| ⬜ | **`/security/disclosure` + `/.well-known/security.txt`** | Standard responsible-disclosure surface. Required by some bug-bounty programs and compliance frameworks. | New: page + a static `/security.txt` file linking to it. | S |
| ⬜ | **`/contact` (or `/support`)** | Even self-serve products need a human escape hatch. Email + a form that lands in a shared inbox. | New: `app/contact/page.tsx`. | S |

### Conversion & SEO drivers

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **`/blog`** with MDX-based posts | Content marketing is the cheapest CAC for PLG. Every post is a long-tail search term. Three types of posts to seed: vulnerability deep-dives, "how to scan X", customer stories. | New: `app/blog/page.tsx` (index) + `app/blog/[slug]/page.tsx` (post). MDX in `content/blog/`. RSS feed for retention. | M |
| ⬜ | **`/changelog`** | PLG users *love* a public changelog — it signals constant shipping and gives them something to follow. | New: `app/changelog/page.tsx` (MDX or hand-written). Auto-tweet new entries (later). | S |
| ⬜ | **`/docs`** with MDX + sidebar nav | Distinct from the in-app help drawer (§3). Docs are public, SEO-indexed, deep-linkable. The community uses these to evaluate before signing up. | New: `app/docs/[...slug]/page.tsx` with MDX + a generated sidebar from frontmatter. Categories: getting-started, scan modes, integrations, API, troubleshooting. | L |
| ⬜ | **Comparison pages** — `/compare/snyk`, `/compare/sonarqube`, `/compare/burp`, etc. | "Snyk alternative" is the highest-intent SEO query in the appsec space. One page per real competitor with an honest feature matrix. | MDX template + per-competitor data file. | M |
| ⬜ | **Use-case / industry pages** — `/for/startups`, `/for/fintech`, `/for/saas`, `/for/agencies` | Every industry self-identifies. SEO + better landing-page conversion than a generic homepage for paid traffic. | MDX template, vary headline + screenshots per vertical. | M |

### Maturity signals (once you have real customers)

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **`/customers`** with case studies | Social proof is the single biggest enterprise-SMB conversion lever. Logo wall + 2–3 deep-dive stories. | New: `app/customers/page.tsx` + per-customer detail pages. | M |
| ⬜ | **`/integrations`** directory | Public, SEO-indexed list of every supported integration with a per-integration page. Doubles as a roadmap-of-integrations signal. | Generate from a config file. | S |
| ⬜ | **`/status`** (uptime / incident page) | Trust + transparency. Embedded widget on `/security`. | Hosted (Statuspage, BetterStack) or self-rolled. | S |
| ⬜ | **`/about`** | Founder background, mission, principles. Especially important for a security tool — "who is this team?" is a real buyer concern. | New: `app/about/page.tsx`. | S |
| ⬜ | **`/careers`** (when hiring) | Talent funnel. | Linked from `/about`. | S |
| ⬜ | **`/press` (brand assets / press kit)** | Logo PNG/SVG, screenshots, founder photos, boilerplate. Cuts journalist friction. | Static assets + a one-pager. | S |

### Content infrastructure (do these once, reuse forever)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **MDX setup** — `next/mdx` with shared components (Callout, CodeBlock, Mermaid) | Every page above benefits. | `next.config.js` + `mdx-components.tsx`. | S |
| ⬜ | **Marketing-site layout shell** | Single header/footer reused across `/blog`, `/docs`, `/legal/*`, `/about`, etc. Distinct from the authenticated `app/(app)/layout.tsx`. | New: `app/(marketing)/layout.tsx` route group. | S |
| ⬜ | **Newsletter signup form** | Embedded on the landing + blog post footers. Captures interest from people who aren't ready to sign up. | Form posts to a service like Resend / Mailerlite, or stores in `email_subscribers` table. | S |
| ⬜ | **Sitemap + robots.txt** | Every public page indexable by Google; private app routes excluded. | `app/sitemap.ts`, `app/robots.ts`. | S |
| ⬜ | **OG image generator** | Per-page Twitter/LinkedIn previews. Especially impactful for blog posts and finding share links (§7). | `next/og` route handler. | S |
| ⬜ | **Analytics with proper consent** | Plausible / Posthog / Fathom — privacy-respecting. Tied to the cookie banner. | Drop-in script in marketing layout. | S |

---

## 3. Out-of-the-box & first-run

The 10-minute clock starts when the user clicks **Sign up**. Everything between that click and "I see a real finding on my code" is what we're optimizing here.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Demo target on every new org.** A pre-seeded target pointing at a deliberately vulnerable public repo (e.g. OWASP Juice Shop or our own [test fixture](webapp/worker/tests/test_runner.py)) with **pre-generated findings** showing the AI-triaged urgency / dismissed / resolved tabs. The user sees the value before paying for a real scan. | Conversion from "signed up" to "saw a finding" without spending an LLM cent. | New: a seed migration that adds a demo `target` + 7 sample findings on org creation. Tag them `is_demo=true` so they don't pollute real metrics. | M |
| ⬜ | **First-run wizard.** Signup → "Add your first target → Pick scan mode → Run" with a 3-step progress bar in the chrome. Skippable. | New users land on `/dashboard` with no targets and no integrations and bounce. | New: `app/(app)/onboarding/page.tsx`, triggered by middleware when `org has 0 real targets`. | M |
| ⬜ | **Smart target detection at signup.** Ask "where's your code?" once. If they paste a GitHub URL, auto-trigger the GitHub OAuth flow + offer to scan immediately. | Squashes 3 separate clicks into one. | Update signup → `/onboarding`. | M |
| ⬜ | **Sane defaults for every form.** Scan mode = `quick` (cheap, fast, demo-friendly). Scope mode = `auto`. Pre-fill name from the URL. | Most onboarding friction is fields the user doesn't know how to set. | Polish pass on `/scans/new`, `/targets/new`. | S |
| ⬜ | **Tooltips on every config field.** Especially scan modes (quick vs standard vs deep), `scope_mode`, `scan_frequency`. | Avoids users guessing. Especially important when the wrong choice costs $. | Add a tooltip component. | S |
| ⬜ | **Built-in help drawer.** Side panel with "how does AI triage work?", "what's a fingerprint?", quickstart + FAQ. Searchable. | Reduces support load + churn from "I don't know what this does". | New: `components/help/`. | M |
| ⬜ | **Free-tier credits up front.** Every new org gets, say, 5 free `quick` scans automatically. The product covers the LLM cost as a CAC. | The cost of running 5 demo scans is pennies; the conversion lift is real. | Wire to the cost-cap system (§1). | S |

---

## 4. Activation & time-to-value

What happens after the wizard. Goal: every new user has at least one *real* scan finding triaged within their first session.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Activation tracking.** Define and instrument: signup → org created → first target → first scan submitted → first scan completed → first finding triaged. Persist in `org_metrics`. | We need to *know* what onboarding works before we optimize it. | Posthog or self-rolled events table. Surface as an admin-only `/admin/funnel` page. | M |
| ⬜ | **In-product nudges.** "You have 0 targets — add one in 30 seconds." "Your first scan is queued — here's what to expect." | Active prompting beats passive empty states for activation. | New: a small banner component that respects user dismissals. | S |
| ⬜ | **Live agent narration.** Today the live event timeline shows raw event types ("tool.execution.started terminal_execute"). Translate into plain English: "Strix is running `curl` against /api/auth to test for IDOR." | Makes a black-box scan feel transparent. Boosts trust + perceived value. | Map event types in [`event-row.tsx`](webapp/frontend/components/scan/event-row.tsx) to friendly templates. | S |
| ⬜ | **Email or push when scan finishes.** Most scans take 5–30 min. Users tab away. | Get them back into the product when there's something to see. | Postgres trigger on `scans.status` change → Edge Function → Resend / SES (free tier). Per-user pref to opt-out. | M |
| ⬜ | **Per-user `notification_preferences`.** Granular: scan-finished, new-finding-fix-now-only, weekly-digest, none. | Without this, notifications become spam. | New table; settings tab. | S |

---

## 5. Free → paid conversion

The PLG monetization layer the project doesn't have yet. The public pricing page itself is in §2; this section is the in-app billing plumbing behind it. Without these, there's no business.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Stripe billing integration.** Self-serve upgrade, plan switching, invoice history, dunning. | Required for revenue. | Stripe Checkout + Webhook → `organizations.stripe_subscription_id`, plan derived from Stripe state. | L |
| ⬜ | **Plan limits + enforcement.** Free tier: 5 scans / month, no scheduled scans, no integrations beyond GitHub. Team: 100 scans / month, 5 schedules, all integrations. Business: unlimited. | The free → paid lever. | Soft (UI warning) and hard (API rejection at `/api/scans` insert) limits. Schema: `organizations.plan_limits jsonb`. | M |
| ⬜ | **Usage dashboard.** "You've used 4 of 5 scans this month. Upgrade for unlimited." with a one-click upgrade CTA. | Makes the limit visible before it bites. | New: `/billing` page. Pulls from `cost_stats` + `scans` count. | M |
| ⬜ | **In-product upgrade prompts.** Friction-free CTAs at the moments of value perception: "Lock in scheduled scans (Team plan)" inside `/targets/new` when the user picks daily/weekly. | Catches the user with intent. | Conditional UI based on `org.plan`. | S |
| ⬜ | **Annual discount.** "Save 20% with annual." Standard PLG conversion lift. | Money. | Stripe price ID. | S |
| ⬜ | **Trial of the next tier.** New orgs get 14 days of Team-tier features. After expiry, soft-degrade to Free. | The trial-to-paid pattern is well-trodden in PLG. | Schema: `organizations.trial_expires_at`. Plan-resolution logic. | M |
| ⬜ | **Self-serve cancellation + downgrade.** "Cancel anytime" needs to actually be one click, not an email. | Trust + churn-reduction-via-trust. | Stripe portal. | S |

---

## 6. Retention loops

Things that keep users coming back to the product after the first hit.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| 🚧 | **Scheduled scans.** The schema has `targets.scan_frequency`; the UI accepts the value. Nothing fires scheduled scans yet. | The single most important retention feature. "Scan my repo every week" is the headline use case. | Worker job: `scripts/schedule_scans.py` runs hourly via `pg_cron` or equivalent, inserts queued scans. | M |
| ⬜ | **Compare two scans (delta).** "What's new since last week's scan?" Diff by fingerprint, sort by AI urgency. | The natural follow-up to the first scan. Drives weekly engagement. | New: `/targets/[id]/compare?from=<scan>&to=<scan>`. | M |
| ⬜ | **Weekly digest email.** "This week: 2 new fix-now findings, 3 fixed, 1 dismissed by AI." Per-target rollup. | Reactivation channel. Builds the habit of opening the dashboard on Mondays. | Cron + email template. | M |
| ⬜ | **Dashboard with trends.** Open findings by severity over time, scan-frequency, cost trend. | Gives users a reason to revisit dashboard between scans. | Recharts on the existing `/dashboard`. | M |
| ⬜ | **Triage with reasoning notes.** Surface the existing `triage_notes` column in the UI; let users add their own. | The "why we dismissed this" context is what teams come back to in audits. | UI: textarea on the FindingCard's expanded triage section. Schema already there. | S |
| ⬜ | **Suppression rules.** Time-bound and scoped. "Dismiss any CWE-89 finding on `/api/internal/*` for 30 days." | Prevents the same false positive from re-appearing forever. | New table `finding_suppressions`. | M |
| ⬜ | **Bulk triage.** Select 10 findings → mark all "false positive" with one note. | The current per-card workflow is fine for 5 findings, painful for 50. | Multi-select on `FindingsFilter`, batch update. | S |

---

## 7. Viral & share surface

PLG growth comes from the existing user base. Make their wins shareable.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Public scan-result share links.** A finding (or a whole scan) gets a unique public URL with a sanitized markdown view. The user controls what's shared (scrubbed of secrets) and shares with their team / a contractor / on Twitter. Sentry / Loom-style virality. | Every share is a potential signup. Standard PLG lever. | New: `app/share/[token]/page.tsx` + `share_links` table with TTL + privacy controls. | M |
| ⬜ | **README badge.** `[![Scanned by webappsec](https://...)]` shows last scan date + open critical count + a green/red status. Users put this on their public READMEs. | Free top-of-funnel for every public repo that adopts. | New: a public PNG/SVG endpoint at `/api/badge/[target_id]`. | S |
| ⬜ | **GitHub Action.** A `usestrix/scan-action@v1` that runs in CI with one YAML stanza. Comments on the PR with new findings. | The single highest-impact integration for SMB dev teams. Lives in their CI, never has to be re-marketed. | New: a separate repo with a small action. Requires the REST API (§7 #1). | L |
| ⬜ | **Public-facing benchmarks.** Voluntary opt-in: "your stack typically has 3 SSRFs; you have 1." Anonymized, aggregated, gated to opted-in users. | Differentiator against generic SAST tools. | New: aggregation cron + anonymized stats table. Privacy review before launch. | L |
| ⬜ | **Findings as conversation.** Slack-thread-style commenting on findings. "Why did we dismiss this?" with searchable history. Public share links can include the thread. | Turns the findings page from a static report into an artifact teams point at. | New table `finding_comments`. UI in expanded card. | M |
| ⬜ | **Refer-a-team.** Each org gets a referral link; both orgs get +5 free scans on signup. | Cheap viral lever. | `referrals` table + signup flow that honors `?ref=` param. | S |

---

## 8. CI/CD plumbing

The first thing any SMB dev team asks: "does it run on every PR?"

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **REST API + scoped API tokens.** `api_tokens` table exists; no API surface uses it. | Required for everything below. | New token-auth middleware that swaps the JWT for a per-token role. Document the public REST surface. | M |
| ⬜ | **GitHub PR comment integration.** A bot comment on the PR with new findings introduced by the diff. Block merge on `fix_now`. | The single most important SAST integration. | New: a webhook or GitHub App. Reuses per-org GitHub integration token. | L |
| ⬜ | **Slack app.** First-class Slack integration. "New critical finding on prod-api → #sec-alerts." Slash commands (`/strix scan myrepo`). | Conversational ergonomics matter for SMB security teams that live in Slack. | Slack app + Edge Function. | L |
| ⬜ | **Webhook integrations (generic + Slack templates).** On `finding.created` (urgency `fix_now`), `scan.failed`, `scan.completed`. | Plugs into existing incident-response loops. | Schema has the integration type; dispatch is unimplemented. | M |
| ⬜ | **GitLab / Azure / GCP integration UIs.** Stubs at `integrations/new/[type]/page.tsx`. | Half the cloud market is unserved today. | Mirror the AWS form pattern. The worker-side credential materialization in `credentials.py` already handles all three. | M |
| ⬜ | **CLI.** `strix scan ./mydir` for the dev who hates web UIs. | Some users prefer CLI; ignoring them is a 10% TAM hit. | Wrap the REST API in a tiny TS or Go binary. | M |

---

## 9. Target coverage for SMB

The asset types our ICP actually has — make scanning each one delightful out of the box.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **GitHub org bulk-add.** "Connect your GitHub org → see every public repo + every private repo we have access to → tick the ones to scan." | A single click adds 30 targets. Catalyzes "I scanned everything" stories that drive virality. | After GitHub OAuth, fetch `/user/repos` and present a checklist. | M |
| ⬜ | **Subdomain auto-discovery.** User adds `acme.com`; we enumerate via CT logs / passive DNS and offer the discovered subdomains as additional targets. | Match the mental model: "scan my company". | Background job using `crt.sh` or similar. New table `target_discoveries`. | M |
| ⬜ | **CIDR / IP-range targets.** Today only single IPs. Allow `203.0.113.0/24`. | A common SMB request: "scan my office IP range". | Schema validation update; worker iterates. | S |
| ⬜ | **Recurring crawl-then-scan.** For deployed web apps, do a polite crawl to enumerate endpoints before scanning. | Modern apps have hundreds of endpoints; the scanner shouldn't have to guess. | Pre-scan crawl phase in the worker; expose `--seeded-from-crawl` to Strix. | L |
| ⬜ | **Target health monitoring.** "Is this target up?" — DNS resolution + a single HEAD request before scanning. Surface failures clearly instead of failing 10 minutes in. | Saves $ + frustration. | Pre-flight check in the worker before spawning Strix. | S |
| ⬜ | **Per-target scan history retention.** SMB users want "last 90 days" not "since the dawn of time". | Storage cost. UX clarity. | Plan-tier-driven retention policy with archive-to-S3 for older runs. | M |
| ⬜ | **Tag / group targets.** "Production", "Staging", "Customer-facing", arbitrary user tags. Filter by tag. | Once a user has 30 targets, they need taxonomy. | New `tags` + `target_tags` tables. | S |

---

## 10. Triage & remediation

Keep AI triage tight. SMB users have no patience for false positives.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| 🚧 | **Cross-scan finding deduplication.** Fingerprint-based collapse so the same finding across N scans is one row. | Massively reduces alert fatigue on rescans. | Foundation in [migration 010](webapp/supabase/migrations/20260428000010_finding_dedup_and_ai_assessment.sql). Open: surface "found in N scans" history clearly. | S |
| 🚧 | **AI triage during the scan flow.** Today triage is a manual `assess_findings.py` script. Wire it into `_upload_run_artifacts` so every finding is auto-triaged the moment it lands. | Removes the manual step. The whole user value is "I don't see false positives" — that has to happen automatically. | [`runner.py`](webapp/worker/src/strix_worker/runner.py) + [`assess_findings.py`](webapp/worker/scripts/assess_findings.py). | S |
| ⬜ | **AI triage with codebase context (RAG).** Today the triage LLM sees only the finding markdown. Giving it the actual source files mentioned in the report would let it confirm reachability rather than guess. | Improves precision from "good guess" to "high confidence". | Index the cloned repo in pgvector; on assess, retrieve top-K chunks per finding's `affected_files`. | L |
| ⬜ | **Fix-suggestion autopilot.** When AI marks a finding `fix_now`, propose a draft PR with a candidate patch. Reviewer-approved, never auto-merged. | The closing of the loop: scan → triage → *fix*. | New worker job using the GitHub integration. Patch generation via the same LLM pipeline. | L |

---

## 11. SOC 2 / ISO-light compliance

SMB compliance is real but lighter than enterprise. Goal: the buyer can hand the auditor a SOC 2 evidence link, not negotiate a 60-day questionnaire.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Audit-log UI.** Data is captured (`audit_log` table); no page renders it. Required for SOC 2 / ISO 27001 evidence. | Compliance. | New: `app/(app)/audit-log/page.tsx`. RLS already restricts to admins. | S |
| ⬜ | **MFA enforcement for admins / owners.** Today MFA is opt-in. | Standard SOC 2 control. An admin password compromise unlocks the org's secrets. | Check in `middleware.ts` + redirect to `/settings/security` for users with role in (`owner`, `admin`) and no `aal2`. | S |
| ⬜ | **SARIF export.** GitHub Code Scanning, GitLab Security Dashboard, and most enterprise SIEMs ingest SARIF. | Without this, security teams can't move findings into existing workflow. | New: `GET /api/findings/export?format=sarif` + per-finding mapping. | M |
| ⬜ | **CSV / JSON export.** Per-target or per-scan dump. | "I just need to give this to a consultant" use case. | Same export route, different format. | S |
| ⬜ | **Compliance mapping.** Auto-tag CWE → OWASP Top 10 / PCI-DSS. Filter by mapping. | Lets non-security users see findings through their compliance lens. | Static mapping table + `findings_compliance` view; UI filter. | M |
| ⬜ | **Per-finding evidence bundle.** "Download a zip of everything we know about this finding" — markdown + events.jsonl slice + affected file snapshots. | Auditors and incident responders. | New: `GET /api/findings/[id]/evidence.zip`. | M |
| ⬜ | **Audit-log retention policy.** Plan-tier-driven retention with archive-to-S3. | SOC 2 requires retention controls. | Same as §8 retention. | M |

---

## 12. Ops & reliability

Keep a small ops team alive while we're growing.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Structured logging across worker + API.** Bind `scan_id` / `org_id` per-task contextvars. | Incident response. Hard to grep "what went wrong for org X" today. | Wrap with `structlog`. | S |
| ⬜ | **OpenTelemetry traces.** API → DB → worker → Strix subprocess. | "Why was this scan slow?" debugging. | OTLP exporter. | M |
| ⬜ | **Health-check endpoints.** `/api/health` + worker `/health`. | Load-balancer + uptime monitoring. | 50-line additions. | S |
| ⬜ | **Worker autoscaling.** Fly.io machines scale 1 → N based on `scans` queue depth. | Predictable scan latency under burst (e.g. when a team adds 30 targets via §8 #1). | `flyctl scale count` driven by a queue-depth metric. | M |
| ⬜ | **Connection pooling tune.** Use the supabase pooler URL + tune psycopg pool. | Scale prep. | Config change. | S |
| ⬜ | **Backup + restore drill.** Document and test the procedure to restore from supabase backup. | DR readiness. | Runbook + drill script. | S |
| ⬜ | **Better error UX.** Most failures today read like raw stack traces ("Could not embed because more than one relationship was found"). Catch and translate. | SMB users without engineering depth on call. | Centralized error handler in API routes; user-friendly messages. | M |

---

## 13. Security hardening

Beyond what's done. The wrapper inherits Strix's isolation guarantees + adds the org boundary; this section closes the remaining gaps in *our* code.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| 🚧 | **Egress firewall in the sandbox.** Pin iptables ALLOW to authorized targets: resolve hostnames at scan start, only allow those IPs/ports inside the sandbox. | Prevents prompt-injection-driven exfiltration. | Rough mitigation today: `isInternalAddress` API-layer rejection. True fix needs sandbox-side iptables + DNS-rebinding protection. | M |
| ⬜ | **Service-role key rotation runbook.** | Standard credential hygiene. | Document + Vercel/Fly secret-rotation procedure. | S |
| ⬜ | **CSP / security headers on the frontend.** Strict CSP, HSTS, X-Frame-Options via `next.config.js`. | XSS defense in depth. | Headers config. | S |
| ⬜ | **PII / secret redaction in instruction_text.** Free-text instructions get logged in `events.jsonl`. If a user pastes test credentials, they end up in the audit log. | Privacy + breach blast-radius reduction. | Strip well-known credential patterns at submit, or at log-write time. | S |
| ⬜ | **Repo-clone URL hardening.** Tighten validators to a strict allow-list of git URL schemes. | Defense in depth. | `app/api/scans/route.ts` — add stricter `isValidRepoUrl`. | S |
| ⬜ | **Secrets-in-events guard.** Property-based test that fails CI if any worker code path puts an env *value* into an event payload. | Regression prevention. | Extend [`test_runner.py`](webapp/worker/tests/test_runner.py). | S |
| ⬜ | **Eat the dog food.** Spin up a staging instance with realistic data, run a deep scan against it. | Validation that the wrapper actually holds up. | Staging deploy + scheduled scan. | M |

---

## 14. Quality & contributor experience

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Frontend tests.** Worker has 49 tests; frontend has zero. The recent "Could not embed because more than one relationship was found" bug took 5 messages to diagnose; a single integration test would have caught it instantly. | Stops regressions. | Vitest + supertest for API routes; Playwright for critical flows (signup → scan → findings). | M |
| ⬜ | **CI pipeline.** `pytest` + `npm run lint / typecheck` not wired to GitHub Actions. | Stops broken commits. | New: `.github/workflows/ci.yml`. | S |
| ⬜ | **Migration / RLS test in CI.** Spin up a clean Supabase, apply migrations, run [`test_supabase_workflows.py`](webapp/worker/tests/test_supabase_workflows.py). Currently they skip without a DB. | Catches RLS regressions like the `org_members` recursion bug. | Service container with `supabase/postgres` image. | M |
| ⬜ | **Type-generated DB types.** Replace hand-written `lib/supabase/types.ts` with `supabase gen types typescript --linked`. | The hand-written file drifts every migration; recent additions had to be added manually. | One-line build step. | S |
| ⬜ | **Pre-commit hooks.** Prettier / eslint / pytest on staged files. | Cuts the "fix lint" round-trip. | `.husky/pre-commit` + `lint-staged`. | S |
| ⬜ | **CONTRIBUTING.md.** Setup, tests, PR etiquette. | Lowers bar for outside contributors. | New file. | S |

---

## 15. Deferred — enterprise motion

Items that belong in a later motion once PLG is proven. Listed for completeness; not on the roadmap until Team-tier ARR clears the threshold.

- **SSO / SAML / SCIM** — Okta / Azure AD / Google Workspace. SMB users today can use their Google login via Supabase's social auth; SAML is for the 500+ employee orgs.
- **Custom roles + fine-grained RBAC** — the four hard-coded roles (owner / admin / member / viewer) are sufficient for SMB.
- **K8s-Job-per-scan compute model** — replaces the host `docker.sock` mount with per-scan ephemeral Jobs. The blast-radius improvement matters at enterprise scale; SMB is fine with the current Docker-host model.
- **Self-hosted air-gapped deployment** — Helm chart, on-prem LLM. Government / defence / regulated-industry customers.
- **BYOK encryption** — customer-managed KMS keys for Vault. Enterprise procurement ask.

When the time comes, these all build on top of what's already there — none of the PLG decisions above lock us out.

---

## 16. Future / research

Bigger ideas, lower confidence on value or feasibility.

- **Differential AI triage.** When a finding's AI assessment changes between scans (e.g. "monitor" → "fix_now" because the codebase changed), surface the delta and the reasoning. Catches silently-degrading code.
- **Threat-model-driven scanning.** Let users describe their app architecture once; the agent uses that as scaffolding for every scan.
- **Auto-remediation safety nets.** Before applying a fix, verify existing tests pass + add a regression test that the original PoC no longer exploits.
- **Replay scans from a specific commit.** "Re-run last quarter's scan, but against commit abc123" — verify a fix landed.
- **Browser extension.** One-click "scan this repo" from a GitHub repo page. Adoption hack — turns the GitHub repo page into a CTA.
- **Anonymized cross-org benchmarks.** Voluntary opt-in: "your stack typically has 3 SSRFs; you have 1." Privacy-respecting.

---

## 17. Already shipped

Reverse-chronological log.

### From PR #2 (`dockerize-and-fixes`)

- Conversion-focused **landing page** at `/` with hero / pain points / features / AI-triage spotlight / how-it-works / final CTA.
- **Targets as a first-class entity** — new table + RLS + tabbed detail page (Overview / Findings / Scans).
- **Editable Settings page** — profile name, org name, per-org LLM provider, Vault-stored API key (write-only, "Set" / "Not set" indicator, two-step clear).
- **Fingerprint-based finding dedup** with `times_seen` / `last_seen_at` ([migration 010](webapp/supabase/migrations/20260428000010_finding_dedup_and_ai_assessment.sql)).
- **LLM-driven AI triage** for reachability + urgency + false-positive flagging ([`scripts/assess_findings.py`](webapp/worker/scripts/assess_findings.py)). Cuts noise from 7 findings → 2 worth fixing in our own dogfood scan.
- **AI urgency surfaced in the UI** — pill on each card, urgency-weighted sort, "Urgent only / Open / All" filter, target dropdown filter.
- **Modern UI pass** — Inter + JetBrains Mono fonts, Lucide icons, glassmorphic sidebar, severity-tinted finding cards, animated status indicators.
- **Triage workflow in the UI** — Fixed / Confirmed real / False positive / Won't fix / Reopen, persisted via supabase-js.
- **Worker dockerized** with `docker-compose.yml` at the repo root.
- **`Dockerfile` fixes** — pull static `docker` CLI from docker.com (Debian 13's `docker.io` no longer ships the CLI); entrypoint that wires `git config url…insteadOf` for private-repo clones with `GITHUB_TOKEN`.
- **`worker_decrypt_org_llm_key`** brought to parity with `worker_decrypt_integration` — audit row + scan-not-found error ([migration 008](webapp/supabase/migrations/20260427000008_worker_decrypt_org_llm_key_audit.sql)).
- **SSRF in `inferTargetType`** rejected at the API boundary ([§4.5 F1 in Architecture.md](Architecture.md#45-findings-from-a-real-white-box-scan-against-this-repo)).
- **Severity parser** fixed — was silently dropping every finding from every scan.
- **JWT hook** fixed — variable shadowing + missing `SECURITY DEFINER` ([migration 007](webapp/supabase/migrations/20260427000007_fix_jwt_hook_variable_shadow.sql)).
- **RLS recursion** on `org_members` fixed via a `SECURITY DEFINER` `has_org_role` helper ([migration 009](webapp/supabase/migrations/20260427000009_break_org_members_rls_recursion.sql)).

### From PR #1 (`architecture-docs-and-tests`)

- [`Architecture.md`](Architecture.md) describing the system's isolation model, scan handling, and roadmap.
- Worker-side tests covering scan lifecycle, parallel cross-org isolation, LLM resolution precedence, credential cleanup, secret-non-leakage.
- SQL workflow tests: pg_notify trigger, JWT hook, RLS isolation, vault-create gate, decrypt-integration enforcement.
- Mock-fidelity tests pinning the fake-Strix mock to real Strix's on-disk format.

---

*Want to tackle one of these? Open a draft PR with a one-paragraph description of your approach. [`Architecture.md`](Architecture.md) is the canonical reference for the isolation model and design choices to preserve.*
