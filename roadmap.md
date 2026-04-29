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

### Three product pillars

Every item below should serve one of these. If it doesn't, it's the wrong item.

1. **An AI security engineer that finds real vulnerabilities, not noise.** The headline of the landing page (*"An AI hacker that finds real vulnerabilities. Without the noise."*) sets the expectation. Findings need PoCs that ran. Coverage needs to be visible. The agent's reasoning needs to feel like a real engineer's, not a stack of regex matches.
2. **Reinforcement-trained: learns from every triage.** *"…learns from every triage you do — so you never see the same false positive twice."* This is the differentiator vs. every other AI-security tool. It only matters if the feedback loop is real: each Fixed / FP / Won't-fix decision must train a per-tenant model that ranks the next finding. The marketing claim is a contract; the roadmap items in §10 below are how we keep it.
3. **PLG-grade signup → payment.** Every product decision below assumes the user can sign up frictionlessly, hit value in <10 minutes, and pay us *self-serve*. Friction in any of the three (signup, activation, billing) silently caps growth.

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
10. [Triage, remediation & continuous learning](#10-triage-remediation--continuous-learning)
11. [Engine plugins — multi-tool architecture](#11-engine-plugins--multi-tool-architecture)
12. [SOC 2 / ISO-light compliance](#12-soc-2--iso-light-compliance)
13. [Ops & reliability](#13-ops--reliability)
14. [Security hardening](#14-security-hardening)
15. [Quality & contributor experience](#15-quality--contributor-experience)
16. [Deferred — enterprise motion](#16-deferred--enterprise-motion)
17. [Future / research](#17-future--research)
18. [Already shipped](#18-already-shipped)

---

## 1. Ship-blockers

Gaps that make the system feel half-built. Close these before anyone outside the team relies on it.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **Stream `events.jsonl` live.** Worker tails the file at 500ms cadence and re-emits each record into `scan_events` (skipping `finding.created` + `chat.message` to avoid duplication / noise). | A 30-min scan with no UI feedback feels broken. | [`runner._stream_events_jsonl`](webapp/worker/src/strix_worker/runner.py). | M |
| ✅ | **Populate token / cost stats.** `StrixStats` parses the rendered stdout panel (humanised tokens + full-precision cost) and forwards through `worker_finish_scan`. | Required for cost caps, billing, plan enforcement (§4). | [`runner.StrixStats`](webapp/worker/src/strix_worker/runner.py). | S |
| ✅ | **Scan-cancel button.** `request_scan_cancel` RPC + `POST /api/scans/[id]/cancel` + worker LISTEN on `scan_cancel` → SIGTERM. UI shows the button on running/queued scans and a "Cancel pending" pill while the worker tears down. | Cost control + trust. | [`request_scan_cancel`](webapp/supabase/migrations/20260429000012_scan_lifecycle.sql), [`runner.cancel_running_scan`](webapp/worker/src/strix_worker/runner.py), [`/api/scans/[id]/cancel`](webapp/frontend/app/api/scans/[id]/cancel/route.ts). | M |
| ✅ | **Atomic scan claim.** New `worker_claim_scan` RPC does the conditional UPDATE + RETURNING in one atomic step; the runner uses it before doing any work. Two workers racing on the same `scan_queued` NOTIFY: only one wins the claim. | Prevents duplicate scans + doubled cost when the worker pool scales. | [`worker_claim_scan`](webapp/supabase/migrations/20260429000012_scan_lifecycle.sql). | S |
| ✅ | **Stuck-scan recovery.** `scans.last_heartbeat_at` updated every 60s by an in-process task; periodic sweep (10-min tolerance) flips silent rows to `failed`. UI surfaces a "Stalled" pill before the auto-fail kicks in. | Operator hygiene + free-tier abuse prevention. | [`worker_heartbeat_scan`](webapp/supabase/migrations/20260429000012_scan_lifecycle.sql), [`mark_stale_scans`](webapp/supabase/migrations/20260429000012_scan_lifecycle.sql), [`runner._heartbeat_loop`](webapp/worker/src/strix_worker/runner.py), [`listener._stale_sweep_loop`](webapp/worker/src/strix_worker/listener.py). | S |

---

## 2. Public marketing site

Pre-signup top-of-funnel. Every page below lives at a public route on the same Next.js app (or a sibling deployment) and feeds traffic into signup. Content for these pages is also reused inside the in-app help (§3) so we don't write things twice.

All of these are static-friendly and a good fit for **MDX in `app/(marketing)/`** with `next/mdx`. Set up once, ship per-page in a few hours.

### Required for launch

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **`/pricing`** with 3 tiers + FAQ block | Three tiers (Free / Team / Business), self-serve upgrade CTAs, 9-question FAQ block with `FAQPage` JSON-LD. | [`pricing/page.tsx`](webapp/frontend/app/(marketing)/pricing/page.tsx). | S |
| ✅ | **`/privacy`** | GDPR / CCPA / DPDP-friendly policy with last-updated stamp. | [`privacy/page.tsx`](webapp/frontend/app/(marketing)/privacy/page.tsx). | S |
| ✅ | **`/terms`** | Plain-English summary up top, full terms below. | [`terms/page.tsx`](webapp/frontend/app/(marketing)/terms/page.tsx). | S |
| ⬜ | **Cookie consent banner.** | Required for EU traffic. Honor `Do-Not-Track`. | New: `components/cookie-banner.tsx` + `cookies-policy` page. | S |
| ✅ | **`/security` (a.k.a. `/trust`)** | Public security posture in 7 pillars covering encryption, tenant isolation, data flow, etc. | [`security/page.tsx`](webapp/frontend/app/(marketing)/security/page.tsx). | S |
| ✅ | **`/security/disclosure` + `/.well-known/security.txt`** | Responsible-disclosure surface with response SLA timeline. | [`security/disclosure/page.tsx`](webapp/frontend/app/(marketing)/security/disclosure/page.tsx) + [`public/.well-known/security.txt`](webapp/frontend/public/.well-known/security.txt). | S |
| ✅ | **`/contact`** | Routed mailboxes (sales / security / support / partnerships) + a form. | [`contact/page.tsx`](webapp/frontend/app/(marketing)/contact/page.tsx). | S |

### Conversion & SEO drivers

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **`/blog`** with markdown-rendered posts + RSS feed | Index page sorted by date, per-post detail page with `Article` JSON-LD, dynamic per-post OG image, and a real `/blog/rss.xml` feed for reader subscriptions. | [`blog/page.tsx`](webapp/frontend/app/(marketing)/blog/page.tsx), [`blog/[slug]/page.tsx`](webapp/frontend/app/(marketing)/blog/[slug]/page.tsx), [`blog/rss.xml/route.ts`](webapp/frontend/app/(marketing)/blog/rss.xml/route.ts). | M |
| ✅ | **`/changelog`** | Shipping log with new/improved/fixed tags, RSS link, dated entries. | [`changelog/page.tsx`](webapp/frontend/app/(marketing)/changelog/page.tsx). | S |
| ⬜ | **`/docs`** with MDX + sidebar nav | Distinct from the in-app help drawer (§3). Docs are public, SEO-indexed, deep-linkable. The community uses these to evaluate before signing up. | New: `app/docs/[...slug]/page.tsx` with MDX + a generated sidebar from frontmatter. Categories: getting-started, scan modes, integrations, API, troubleshooting. | L |
| ⬜ | **Comparison pages** — `/compare/snyk`, `/compare/sonarqube`, `/compare/burp`, etc. | "Snyk alternative" is the highest-intent SEO query in the appsec space. One page per real competitor with an honest feature matrix. | MDX template + per-competitor data file. | M |
| ⬜ | **Use-case / industry pages** — `/for/startups`, `/for/fintech`, `/for/saas`, `/for/agencies` | Every industry self-identifies. SEO + better landing-page conversion than a generic homepage for paid traffic. | MDX template, vary headline + screenshots per vertical. | M |

### Maturity signals (once you have real customers)

| | Page | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **`/customers`** with case studies | Social proof is the single biggest enterprise-SMB conversion lever. Logo wall + 2–3 deep-dive stories. | New: `app/customers/page.tsx` + per-customer detail pages. | M |
| ⬜ | **`/integrations`** directory | Public, SEO-indexed list of every supported integration with a per-integration page. Doubles as a roadmap-of-integrations signal. | Generate from a config file. | S |
| ⬜ | **`/status`** (uptime / incident page) | Trust + transparency. Embedded widget on `/security`. | Hosted (Statuspage, BetterStack) or self-rolled. | S |
| ✅ | **`/about`** | Founding principles + the values that shape the product. | [`about/page.tsx`](webapp/frontend/app/(marketing)/about/page.tsx). | S |
| ⬜ | **`/careers`** (when hiring) | Talent funnel. | Linked from `/about`. | S |
| ⬜ | **`/press` (brand assets / press kit)** | Logo PNG/SVG, screenshots, founder photos, boilerplate. Cuts journalist friction. | Static assets + a one-pager. | S |

### Content infrastructure (do these once, reuse forever)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **MDX setup** — `next/mdx` with shared components (Callout, CodeBlock, Mermaid) | Every page above benefits. Today posts live in a static TS registry; MDX would unlock per-post components and richer formatting. | `next.config.js` + `mdx-components.tsx`. | S |
| ✅ | **Marketing-site layout shell** | Header/footer reused across all marketing routes via the `(marketing)` route group. | [`(marketing)/layout.tsx`](webapp/frontend/app/(marketing)/layout.tsx). | S |
| ⬜ | **Newsletter signup form** | Embedded on the landing + blog post footers. Captures interest from people who aren't ready to sign up. | Form posts to a service like Resend / Mailerlite, or stores in `email_subscribers` table. | S |
| ✅ | **Sitemap + robots.txt** | Public marketing pages + dynamic blog posts in `/sitemap.xml`; auth/api/dashboard routes disallowed in `/robots.txt`. | [`app/sitemap.ts`](webapp/frontend/app/sitemap.ts), [`app/robots.ts`](webapp/frontend/app/robots.ts). | S |
| ✅ | **OG image generator** | Default `/opengraph-image` rendered via `next/og` for every page; per-blog-post OG image baked at build time. Twitter card uses the same artwork via `summary_large_image`. | [`app/opengraph-image.tsx`](webapp/frontend/app/opengraph-image.tsx), [`blog/[slug]/opengraph-image.tsx`](webapp/frontend/app/(marketing)/blog/[slug]/opengraph-image.tsx). | S |
| ✅ | **SEO foundation: metadataBase + per-page metadata + structured data** | `metadataBase` + canonical URLs + openGraph + twitter on every marketing page via a shared `buildPageMetadata` helper. `Organization` + `WebSite` JSON-LD on every page from the root layout; `Article` JSON-LD on blog posts; `FAQPage` JSON-LD on pricing. | [`lib/seo.ts`](webapp/frontend/lib/seo.ts), [`app/layout.tsx`](webapp/frontend/app/layout.tsx). | S |
| ⬜ | **Analytics with proper consent** | Plausible / Posthog / Fathom — privacy-respecting. Tied to the cookie banner. | Drop-in script in marketing layout. | S |

---

## 3. Out-of-the-box & first-run

The 10-minute clock starts when the user clicks **Sign up**. Everything between that click and "I see a real finding on my code" is what we're optimizing here.

### Signup mechanics

The pillar-3 plumbing below the wizard. Most PLG signups never finish if any of these is awkward — and they're invisible until they break.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Social OAuth at signup — Google + GitHub + Microsoft.** Most dev signups happen via OAuth, not email. GitHub is the highest-converting because it doubles as the integration auth (one click, you're signed up *and* connected to your repos). | Email/password is the worst-converting signup form in PLG. ~60% of dev tools see >70% of signups via Google or GitHub. | Supabase already supports all three; wire the buttons + post-signup redirect. | S |
| ⬜ | **Magic-link signup option** (passwordless email). | Removes the "what password did I use?" friction on revisit. Best-in-class default for tools where the user signs in from multiple machines. | Supabase OTP. Need a styled "check your email" page. | S |
| ⬜ | **Email verification with a friendly UX.** Enabled today (after [migration 008]) but the verify-email flow is bare. A clear "we sent you a link, here's what to do if it doesn't arrive" page; a "resend" button; idempotent re-send rate-limit. | Today users hit a generic Supabase error if they don't verify. PLG conversion drops sharply when the verify step looks broken. | New: `/auth/verify-pending` page. | S |
| ⬜ | **Welcome email** (transactional, not marketing). Confirms the account, links the demo target, offers help. Sent via Resend / Postmark / SES. | Sets expectations. Feels professional. Costs ~zero. | Postgres trigger on `auth.users` insert → Edge Function → email service. | S |
| ⬜ | **Bot protection on `/signup`.** Cloudflare Turnstile or hCaptcha invisible challenge, plus a per-IP rate-limit (e.g. 10/min). | Free-tier signups are an obvious abuse vector. Without this, a bot signs up 10k orgs and burns the free LLM budget overnight. Same call-out as plan-limit enforcement (§5). | Add the widget on `/signup`; verify token in `/api/auth/signup`; rate-limit via Vercel/Edge middleware. | S |
| ⬜ | **Org switcher in the app chrome.** A user invited to multiple orgs needs a clean dropdown, not "log out and back in" friction. | The team-collaboration story falls apart without it. Every PLG B2B tool has one. | New: dropdown in [`app/(app)/layout.tsx`](webapp/frontend/app/(app)/layout.tsx) sidebar. Driven by `org_members` for current user. | S |
| ⬜ | **Invite teammates from any page.** Cmd-K → "Invite". Or a persistent "Invite team" button in the chrome that opens a modal. | The sooner a single-user org becomes a multi-user org, the higher the LTV. Make it impossible to miss. | New: `components/invite-modal.tsx`. Email + role; sends a magic-link invite. | S |
| ⬜ | **Profile completion nudge.** After signup, gently ask for full name + role. Used for personalized emails + admin-only analytics. | Data hygiene. Costs nothing if the user dismisses. | Optional inline prompt on first dashboard visit. | S |

### Activation mechanics

Everything between signup landing and the first triaged finding.

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

### Core billing

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Stripe billing integration.** Self-serve upgrade, plan switching, invoice history, dunning. | Required for revenue. | Stripe Checkout + Webhook → `organizations.stripe_subscription_id`, plan derived from Stripe state. | L |
| ⬜ | **Pricing tiers as DB schema.** Single source of truth `plans` table mapping plan codes (`free`, `team`, `business`) to feature flags + limits. The marketing pricing page reads from it; plan-limit enforcement (§5 row 3) reads from it; Stripe price IDs map back to it. | Today the pricing page hardcodes plan features in JSX. Drift is inevitable. | New table `plans`. UI + worker read from it. | S |
| ⬜ | **Plan limits + enforcement.** Free tier: 5 scans / month, no scheduled scans, no integrations beyond GitHub. Team: 100 scans / month, 5 schedules, all integrations. Business: unlimited. | The free → paid lever. | Soft (UI warning) and hard (API rejection at `/api/scans` insert) limits. Schema: `organizations.plan_limits jsonb`. | M |
| ⬜ | **Usage dashboard.** "You've used 4 of 5 scans this month. Upgrade for unlimited." with a one-click upgrade CTA. | Makes the limit visible before it bites. | New: `/billing` page. Pulls from `cost_stats` + `scans` count. | M |
| ⬜ | **In-product upgrade prompts.** Friction-free CTAs at the moments of value perception: "Lock in scheduled scans (Team plan)" inside `/targets/new` when the user picks daily/weekly. | Catches the user with intent. | Conditional UI based on `org.plan`. | S |
| ⬜ | **Annual discount.** "Save 20% with annual." Standard PLG conversion lift. | Money. | Stripe price ID. | S |
| ⬜ | **Trial of the next tier.** New orgs get 14 days of Team-tier features. After expiry, soft-degrade to Free. | The trial-to-paid pattern is well-trodden in PLG. | Schema: `organizations.trial_expires_at`. Plan-resolution logic. | M |
| ⬜ | **Self-serve cancellation + downgrade.** "Cancel anytime" needs to actually be one click, not an email. | Trust + churn-reduction-via-trust. | Stripe portal. | S |

### Billing plumbing (the unsexy stuff that breaks PLG when missing)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Stripe webhook idempotency + replay safety.** Every Stripe event must be safe to receive twice. Persist `stripe_event_id` + check before applying. Replay-from-dashboard must be no-op-on-success. | Stripe retries failed deliveries; without idempotency you double-charge / double-grant. The single most common PLG billing bug. | New table `stripe_events` (event_id PK + processed_at). Idempotency middleware in the webhook handler. | S |
| ⬜ | **Stripe Tax integration.** VAT for EU customers, GST for India / Australia, sales tax for US. Required to invoice legally above the local threshold. | Without it, every EU/India sale is a compliance landmine. Stripe Tax handles the hard part if you wire it up. | Enable on the Stripe account; pass `automatic_tax: { enabled: true }` to Checkout sessions. | S |
| ⬜ | **Failed payment grace period.** A failed renewal triggers Stripe's smart-retries (3 attempts over 21 days by default). During grace, mark org as `past_due` in our schema; show a banner; *don't* downgrade for 7 days. After 7d → soft-downgrade to Free with read-only access to historical data. | The default behaviour ("payment failed → instant downgrade → user lockout → angry tweet") is a churn accelerator. Grace is standard PLG. | Webhook handler for `invoice.payment_failed` + `customer.subscription.past_due`; banner component; downgrade cron. | M |
| ⬜ | **Coupon / promo code support.** Standard PLG growth lever — Black Friday, partnership launches, conference codes, recovery from outage. | Without coupons, every offer is a manual Stripe-dashboard ad-hoc. | Wire Stripe Coupon API into Checkout; add a `?code=` URL param the upgrade flow honours. | S |
| ⬜ | **Receipts + invoices via email + portal download.** PDF download of every paid invoice. Auto-emailed receipt on renewal. | Standard expectation. SMB finance teams *will* ask. | Stripe portal already does both; expose the link from `/billing`. | S |
| ⬜ | **Per-event transactional emails.** Welcome (post-signup), upgraded (post-payment), payment-failed, trial-expiring-in-3-days, downgraded, win-back-after-30d-inactive. | These are the conversion / retention emails every PLG runbook ships. | Resend / Postmark; email template per event; trigger from Stripe webhook + `auth.users` events. | M |
| ⬜ | **Seat-vs-org billing model decision.** Pricing page implies per-org but Team plans usually need a seat cap (e.g. 5 seats included, $20/extra). Decide once, encode in the `plans` table, build the seat-counter logic. | Ambiguity here breaks the upgrade flow. Picking the wrong model in MVP is harder to fix later. | Decision: per-org + capped seats with overage billing. Schema: `organizations.included_seats`. | S |
| ⬜ | **Billing audit trail.** Every plan change, payment, refund logged in `audit_log` with the Stripe event ID. | Compliance + customer-support readiness. | Hook into existing `audit_log` writes from webhook handler. | S |
| ⬜ | **Refund policy + workflow.** Document the 30-day refund policy on `/pricing`; one-click refund issuance from an admin-only page. | A real refund policy is a conversion lever; a refund button is a support-load reducer. | Stripe Refund API + admin UI gate. | S |

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

## 10. Triage, remediation & continuous learning

Keep AI triage tight. SMB users have no patience for false positives. **The "learns from every triage" claim on the landing page lives or dies here.**

### Stateless triage (no human in loop)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| 🚧 | **Cross-scan finding deduplication.** Fingerprint-based collapse so the same finding across N scans is one row. | Massively reduces alert fatigue on rescans. | Foundation in [migration 010](webapp/supabase/migrations/20260428000010_finding_dedup_and_ai_assessment.sql). Open: surface "found in N scans" history clearly. | S |
| 🚧 | **AI triage during the scan flow.** Today triage is a manual `assess_findings.py` script. Wire it into `_upload_run_artifacts` so every finding is auto-triaged the moment it lands. | Removes the manual step. The whole user value is "I don't see false positives" — that has to happen automatically. | [`runner.py`](webapp/worker/src/strix_worker/runner.py) + [`assess_findings.py`](webapp/worker/scripts/assess_findings.py). | S |
| ⬜ | **AI triage with codebase context (RAG).** Today the triage LLM sees only the finding markdown. Giving it the actual source files mentioned in the report would let it confirm reachability rather than guess. | Improves precision from "good guess" to "high confidence". | Index the cloned repo in pgvector; on assess, retrieve top-K chunks per finding's `affected_files`. | L |
| ⬜ | **Fix-suggestion autopilot.** When AI marks a finding `fix_now`, propose a draft PR with a candidate patch. Reviewer-approved, never auto-merged. | The closing of the loop: scan → triage → *fix*. | New worker job using the GitHub integration. Patch generation via the same LLM pipeline. | L |

### Reinforcement learning from triage (pillar 2)

The contract behind *"learns from every triage you do — so you never see the same false positive twice."* Every Fixed / Confirmed-real / False-positive / Won't-fix click on a FindingCard is a labeled training pair. Without the items below, those clicks vanish. Designed for **per-tenant isolation** — the loop never trains across orgs (privacy promise on the landing page).

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Persisted triage as labeled training pairs.** Every triage decision becomes a row in `triage_signals` with `(finding_id, finding_embedding, decision, decided_at, decided_by, org_id)`. The triage UI already writes `findings.status` + `triage_notes`; this captures the same decision in a model-friendly shape. | Without persistence, "the model gets sharper with use" is marketing. With it, every click is a gradient step. | New table `triage_signals`. Embedding via the existing LLM pipeline. Per-org RLS — never readable across tenants. | M |
| ⬜ | **Per-org ranking model.** A small model (logistic regression / gradient-boosted trees / distilled LLM-as-classifier) takes a new finding's features + the org's recent `triage_signals` and predicts `(urgency, confidence, p_false_positive)`. Used to rank `/findings` and bias the auto-dismiss threshold. | Per-tenant tuning is the differentiator. The blog post promises FP rate drops from 7% to <1% by week 4 — that only happens if a model learns the org's tolerances. | Train on each `triage_signals` insert; persist weights at `org_models` keyed by org. Cold-start bootstrap from a permissive prior. | L |
| ⬜ | **Triage suggestions ("we think this is FP — confirm?").** When the per-org model is >70% confident a new finding is a false positive, the FindingCard surfaces *"Likely false positive — based on 14 similar dismissals."* with one-click Confirm / Override. | Saves clicks on routine cases; every Confirm/Override is a labeled training pair (active learning). | UI on FindingCard. Suggestion writes a `triage_signals` row regardless of which button the user clicks. | M |
| ⬜ | **Auto-dismiss high-confidence false positives.** When the model is >95% confident *and* the same fingerprint has been dismissed by this org before, auto-dismiss with a clear "we dismissed this — see why / undo" affordance in the dismissed tab. | The single biggest perceived-value improvement: the user never sees the FP at all. Reversibility is non-negotiable; the user must be able to override. | Background job after triage; UI badge on auto-dismissed findings. | M |
| ⬜ | **Pattern → permanent suppression.** The model notices "this org always dismisses CWE-89 findings on `/api/internal/*`". Surface the pattern; offer one click to convert it into a real `finding_suppressions` rule (§6 row 6). | Closes the loop from "we noticed" to "you fixed the rule that made us notice". | Pattern detection job; UI prompt. Re-uses the suppression-rule schema. | M |
| ⬜ | **Active learning prompts on borderline cases.** When the model's confidence is 0.4–0.6 (genuinely unsure), show a small banner: *"We're not sure about this — your call helps us learn."* | Targeted requests for human input where the marginal information gain is highest. | UI banner conditional on confidence band. | S |
| ⬜ | **Confidence display + filter on every finding.** Each card shows a small "AI confidence: 0.82 (verified)" badge with hover tooltip explaining what that means. Filter chip to show "high confidence only" / "needs review". | Honest UX. Lets the user calibrate their own trust in the model. | UI on FindingCard + FindingsFilter. | S |
| ⬜ | **Triage-drift detection.** When a per-org model's hold-out accuracy starts dropping (e.g. user keeps overriding its dismissals), notify the org owner: "your team's triage patterns have changed — shall we retrain on recent signal only?" | A model that silently miscalibrates is worse than a stateless one. | Periodic eval job comparing model-predicted urgency vs subsequent triage on held-out findings. Slack/email alert on drift. | M |
| ⬜ | **"Reset & retrain" controls.** Power-user setting: "ignore signal older than 90 days" / "retrain from scratch". For when an org's stack changes shape. | Trust + control. | Settings page action, nukes `triage_signals` and rebuilds the model. | S |
| ⬜ | **Cross-finding triage history on the card.** "You've triaged 12 similar findings before — 10 dismissed, 2 fixed." Shown in the expanded card. | Memory feels like a real engineer; gives the user context for their own decision. | Query `triage_signals` by fingerprint family; render. | S |

### AI security engineer surface (pillar 1)

Make the agent feel like a real security engineer, not a stack of regex matches. Every item below is about *how the work shows up* in the UI, not the work itself.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Agent specialisation labels.** When Strix spawns sub-agents, label them by attack class (Recon / Auth-bypass / Injection / SSRF / Authz). Today they all read "Investigator #N". Some of this is upstream ([tools-wishlist.md](tools-wishlist.md) §0); we can also infer the label from the tool-call pattern. | "An AI security engineer" feels real when the team has named roles. Generic "Investigator #3" doesn't. | Heuristic labelling in [`agents-section.tsx`](webapp/frontend/components/scan/agents-section.tsx) until upstream tags arrive. | S |
| ⬜ | **Multi-step kill-chain narrative.** When a finding required several steps (leaked credential → re-used to log in → escalated to admin), render the chain as a numbered timeline with the agent's reasoning between each step. | Differentiates from pattern-matchers. Shows real adversarial thinking. The events are already in `scan_events`; this is presentation. | New `KillChain` component; group `tool.execution.*` + `chat.message` events for each finding. | M |
| ⬜ | **PoC verification badge.** Every finding marked "verified" if the agent ran an exploit that actually triggered. *"PoC ran — vulnerable response captured."* vs *"Pattern match — not verified."* Big visual difference on the card. | The "real vulnerabilities, not noise" promise hinges on this distinction. Verified findings should look unmistakably different. | Schema: `findings.verification_status`. Set during scan based on tool-call outcomes. UI badge. | M |
| ⬜ | **Negative coverage assertions.** "We tested `/api/auth` for SQLi, IDOR, and broken session — clean." Most scanners list only what they found; we should list what we tested *and didn't* find. | A scan that returns 0 findings looks like the scanner failed; a scan that returns 0 findings *plus a coverage report* looks like a clean bill of health. | Some upstream ask ([tools-wishlist.md](tools-wishlist.md) §0 *Semantic checkpoint events*); some derivable today from tool calls + endpoints touched. | M |
| ⬜ | **Cross-scan memory ("last scan we saw X here").** When a target is rescanned, the agent narrative references prior findings: *"Re-checked the SSRF on `/api/scans` — still vulnerable"* or *"Re-checked the SSRF on `/api/scans` — fixed."* Schema-wise we already have the history; this is surfacing it. | Real engineers remember. Stateless tools forget. | Pre-prompt the assess pipeline with the target's prior scan summary. | M |
| ⬜ | **Hand-off to a human.** A "request human review" button on any finding. Routes to a paid-tier service (us — or eventually a marketplace of contractors). | Some findings need a human. Owning the hand-off keeps users in the product instead of bouncing to Burp / contractor / consultancy. | New table `review_requests`; admin queue; pricing tier. | L |
| ⬜ | **Plain-language scan summary at the top.** "Scanned 12 endpoints across `acme.com`. The agent found 1 critical SSRF (verified) and 2 medium misconfigurations. Authentication and access-control checks passed." Currently the user has to read the findings list to figure that out. | The 30-second summary is what the security-minded staff engineer forwards to their team chat. Make it copyable and well-formed. | Generated from triage results + coverage data; rendered above the findings list. Some upstream ([tools-wishlist.md](tools-wishlist.md) §0 *run.summary event*). | S |

---

## 11. Engine plugins — multi-tool architecture

Today the wrapper is hard-wired to Strix. Adding Semgrep, Trivy, ZAP, Nuclei, GitLeaks, Bandit, or anything else means forking [`runner.py`](webapp/worker/src/strix_worker/runner.py) — Strix-specific assumptions are baked in everywhere (events.jsonl path, `vuln-NNNN.md` markdown shape, the rendered stdout panel regex for token stats, exit-code 0/2 = success, env vars `STRIX_LLM` / `STRIX_BIN` / `STRIX_IMAGE`, the entire module name `strix_worker`).

**The framing this unlocks** keeps the brand promise honest: *"An AI security engineer that runs the right tools for the job."* Strix stays the lead engine — it's the AI agent that exploits and learns. Stateless tools (Semgrep / Trivy / ZAP / Nuclei) become first-pass filters whose output normalises into the same triage flow. The "no false positives" claim has to hold across every tool, not just Strix — which means the items below all feed into the §10 reinforcement-learning loop.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Pluggable tool adapter interface.** Abstract the Strix-specific subprocess driver into a `BaseTool` protocol: `build_command(scan, target) → cmd`, `parse_events(stream) → ScanEvent[]`, `parse_findings(workdir) → Finding[]`, `extract_stats(stdout) → StatsSnapshot`, `sandbox_config() → SandboxSpec`. Strix becomes one implementation; each new tool is a ~200-line adapter. | Today every Strix-specific assumption is hard-coded in [`runner.py`](webapp/worker/src/strix_worker/runner.py). Adding any other tool = fork-and-duplicate. | New: `webapp/worker/src/scan_worker/tools/{base,strix,semgrep,trivy,zap,nuclei,gitleaks}.py`. Rename module `strix_worker` → `scan_worker`. | L |
| ⬜ | **Tool catalog table** (`tools` + `org_tools`). Catalog of supported engines with per-org enable / disable / config. Each row carries supported `target_types`, default config, plan-tier gating, current pinned version. | The frontend needs to know which tools the org can pick from + which require which plan tier. Without a catalog, every tool addition is a hardcoded UI change. | New tables. UI surface in `/settings/scanners`. | M |
| ⬜ | **`scans.tool` + `findings.detected_by` columns.** Today every scan is implicitly Strix; every finding's source is implicit. Track which engine ran on each scan + which engine(s) found each finding. `detected_by` is a `text[]` so cross-tool dedup can merge sources. | Required for the "Detected by Semgrep + Strix" badge, cross-tool dedup, per-tool retention policy, per-tool cost attribution, per-tool drift detection in the RL loop. | New migration. | S |
| ⬜ | **Canonical finding schema (the contract).** Every adapter normalises to one shape: `(severity, cwe, category, target, endpoint, file, line, description_md, poc_md, remediation_md)`. Tool-specific extras live in `findings.tool_metadata jsonb`. The triage layer + UI work *only* on canonical fields. | Without this contract, tool diversity bleeds into the UI and the §10 RL loop. With it, adding a tool is invisible to anything downstream. | Document the contract in [`Architecture.md`](Architecture.md). The current schema is mostly there; just needs each adapter to conform. | S |
| ⬜ | **SARIF intake** (one adapter that unlocks ten tools). Semgrep, CodeQL, Trivy, Snyk, Bandit, GitLeaks, Checkov, KICS, tfsec, tflint all speak SARIF. A single SARIF parser → canonical finding mapper covers them. | Lowest-effort way to support most of the OSS security ecosystem. Pairs symmetrically with the SARIF *export* tracked in §12. | New: `tools/sarif.py`. | M |
| ⬜ | **Multi-tool scan composition.** One `scans` row fans out to N tool runs; findings aggregate; the scan completes when all tools finish. Default policy routes by target type (repo → Strix + Semgrep + GitLeaks; web app → Strix + ZAP + Nuclei; container image → Trivy; domain → Nuclei + subfinder). | Without this, the UX is "pick one tool" — confusing for users who don't know the difference. With it, the UX is "we picked the right tools for this target". The AI-orchestrator framing only makes sense at the multi-tool layer. | New table `scan_runs` (one per tool per scan). Worker dispatches per tool concurrently, awaits all, finalises one scan row. | M |
| ⬜ | **Cross-tool finding deduplication.** Generalise the existing fingerprint to be tool-agnostic. Same `(file, line, cwe)` from Strix + Semgrep collapses to one row with `detected_by: ['strix','semgrep']`; users see one finding. The triage signal in §10 trains on the merged record. | A multi-tool scan that returns 3× the findings is the *opposite* of the no-noise promise. | Extend `_compute_fingerprint`; merge logic in `worker_insert_finding`. | M |
| ⬜ | **Per-target tool routing + override.** Sane defaults per `target.type` so most users don't choose. Power users can override per scan or per target ("never run ZAP on this target"). | Onboarding (§3) should not surface 7 checkboxes on first scan. | UI default in `/scans/new`; per-target override in `/targets/[id]/settings`. Routing table from the tool catalog. | M |
| ⬜ | **Per-tool resource budgets.** Semgrep finishes in 60 s; Strix runs 30 min. Trivy is fast. ZAP is slow. Different timeouts, memory limits, concurrency caps, cost-cap weightings per tool. | Today the worker's heartbeat / stale-scan / cancel / cost logic uses one timeout. Without per-tool budgets, fast tools wait on slow ones; slow tools get killed by fast-tool sweeps. | `tools.config jsonb` with budget fields. Worker reads at dispatch. | S |
| ⬜ | **Tool versioning + reproducibility.** Pin the exact tool version on every `scan_runs` row. Findings reference the version. | When Semgrep ships a new ruleset, today's findings shouldn't silently look outdated; we should know which ruleset surfaced what. Lets us replay a scan against the old version on demand. | Schema. Adapter captures version at dispatch. | S |
| ⬜ | **Per-tool sandbox isolation.** Strix needs `--privileged` Docker for its full agent loop; Trivy needs registry creds; ZAP needs a target URL allow-list; Semgrep needs no network at all. Each adapter declares its sandbox needs (network rules, mounts, dropped capabilities). Worker enforces. | The current blanket privileged mount is overkill for tools that only need a filesystem. Cross-references §14 (Security hardening). | Adapter declares `SandboxSpec`; worker translates to `docker run` flags. | M |
| ⬜ | **Plan-tier gating per tool.** Free = Strix only (lead engine). Team = + Semgrep + GitLeaks (fast OSS adds). Business = + Trivy + ZAP + Nuclei + custom rule packs. | The pricing page (§5) needs something to differentiate tiers besides scan count. Tool access is the natural lever for technical users. | Tool catalog reads `plan_min` per tool. | S |
| ⬜ | **Generalise [`tools-wishlist.md`](tools-wishlist.md).** Today it's only Strix asks. Refactor into per-tool subsections, each tracking that tool's upstream gaps. | Same patterns repeat upstream (events stream, semantic categories, summary at end). Tracking them per-tool keeps asks organised when we're talking to multiple maintainers. | Refactor in place. | S |

---

## 12. SOC 2 / ISO-light compliance

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

## 13. Ops & reliability

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

## 14. Security hardening

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

## 15. Quality & contributor experience

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ⬜ | **Frontend tests.** Worker has 49 tests; frontend has zero. The recent "Could not embed because more than one relationship was found" bug took 5 messages to diagnose; a single integration test would have caught it instantly. | Stops regressions. | Vitest + supertest for API routes; Playwright for critical flows (signup → scan → findings). | M |
| ⬜ | **CI pipeline.** `pytest` + `npm run lint / typecheck` not wired to GitHub Actions. | Stops broken commits. | New: `.github/workflows/ci.yml`. | S |
| ⬜ | **Migration / RLS test in CI.** Spin up a clean Supabase, apply migrations, run [`test_supabase_workflows.py`](webapp/worker/tests/test_supabase_workflows.py). Currently they skip without a DB. | Catches RLS regressions like the `org_members` recursion bug. | Service container with `supabase/postgres` image. | M |
| ⬜ | **Type-generated DB types.** Replace hand-written `lib/supabase/types.ts` with `supabase gen types typescript --linked`. | The hand-written file drifts every migration; recent additions had to be added manually. | One-line build step. | S |
| ⬜ | **Pre-commit hooks.** Prettier / eslint / pytest on staged files. | Cuts the "fix lint" round-trip. | `.husky/pre-commit` + `lint-staged`. | S |
| ⬜ | **CONTRIBUTING.md.** Setup, tests, PR etiquette. | Lowers bar for outside contributors. | New file. | S |

---

## 16. Deferred — enterprise motion

Items that belong in a later motion once PLG is proven. Listed for completeness; not on the roadmap until Team-tier ARR clears the threshold.

- **SSO / SAML / SCIM** — Okta / Azure AD / Google Workspace. SMB users today can use their Google login via Supabase's social auth; SAML is for the 500+ employee orgs.
- **Custom roles + fine-grained RBAC** — the four hard-coded roles (owner / admin / member / viewer) are sufficient for SMB.
- **K8s-Job-per-scan compute model** — replaces the host `docker.sock` mount with per-scan ephemeral Jobs. The blast-radius improvement matters at enterprise scale; SMB is fine with the current Docker-host model.
- **Self-hosted air-gapped deployment** — Helm chart, on-prem LLM. Government / defence / regulated-industry customers.
- **BYOK encryption** — customer-managed KMS keys for Vault. Enterprise procurement ask.

When the time comes, these all build on top of what's already there — none of the PLG decisions above lock us out.

---

## 17. Future / research

Bigger ideas, lower confidence on value or feasibility.

- **Differential AI triage.** When a finding's AI assessment changes between scans (e.g. "monitor" → "fix_now" because the codebase changed), surface the delta and the reasoning. Catches silently-degrading code.
- **Threat-model-driven scanning.** Let users describe their app architecture once; the agent uses that as scaffolding for every scan.
- **Auto-remediation safety nets.** Before applying a fix, verify existing tests pass + add a regression test that the original PoC no longer exploits.
- **Replay scans from a specific commit.** "Re-run last quarter's scan, but against commit abc123" — verify a fix landed.
- **Browser extension.** One-click "scan this repo" from a GitHub repo page. Adoption hack — turns the GitHub repo page into a CTA.
- **Anonymized cross-org benchmarks.** Voluntary opt-in: "your stack typically has 3 SSRFs; you have 1." Privacy-respecting.

---

## 18. Already shipped

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
