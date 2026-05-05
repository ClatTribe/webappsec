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

Two dimensions to cover for every asset type:

1. **Per-type completeness.** Does the schema + UI capture every option a user has in their head when they say "scan this thing"? (e.g. *which* branch on a repo, *what* credentials for a web app, *which* ports on an IP, *which* subdomains under a domain).
2. **End-to-end plumbing.** Does the worker translate those options into something Strix actually acts on? Strix's CLI surface today is small (`-t`, `--instruction`, `-m`, `--scope-mode`, `--diff-base`), so most options either get expressed as augmented natural-language instruction text or need a new flag (tracked in [`tools-wishlist.md`](tools-wishlist.md)).

The schema slot is already there — `targets.metadata jsonb` is unused. The proposal: type-discriminate it, validate at the API boundary with zod, and have a worker-side template translate each field into Strix-friendly form before invocation.

### 9.1 Foundational plumbing (do before per-type forms)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **Typed per-type config schema.** `targets.config jsonb NOT NULL DEFAULT '{}'` with a discriminated zod validator at the API boundary ([`lib/target-config.ts`](webapp/frontend/lib/target-config.ts)) keyed on `targets.type`. Schema-only DB layer (no plpgsql shape check) — API + RLS are the only writers. Type included in `Target.config: Record<string, unknown>`. | Today `metadata` was generic + empty. Without a typed slot, every per-type field had to live in free-form `instruction_text` — fragile and unauditable. | [`migration 016`](webapp/supabase/migrations/20260429000016_target_config.sql), [`/api/targets`](webapp/frontend/app/api/targets/route.ts). | M |
| ✅ | **Per-type forms on `/targets/new`.** A single dynamic form keyed on `resolvedType`. Each type renders its own field block: `repository` (branch + subdirectory), `web_application` (crawl_seeds + rate_limit_qps), `domain` (subdomain_excludes), `ip_address` (port_spec + protocols), `local_code` (path_excludes + language_hints). Only the fields relevant to the resolved type ship in the request body. | One form for five wildly different concepts (repo, web app, domain, IP, local code) is the wrong default. | [`targets/new/page.tsx`](webapp/frontend/app/(app)/targets/new/page.tsx) — `buildConfigForType` helper. | M |
| ✅ | **Worker-side instruction augmenter.** [`instruction.build_instruction`](webapp/worker/src/strix_worker/instruction.py) reads `targets.config` (joined into `fetch_scan` so no extra round-trip), translates each known field to natural-language text, and appends it to the user's free-form `scan.instruction_text` before passing the combined string to Strix's `--instruction`. Per-type augmenters: `repository`, `web_application`, `domain`, `ip_address`, `local_code`. Unknown target types fall through silently. | Most per-type fields can be expressed in natural language Strix understands without a new CLI flag. The hard ones (auth creds, port specs, rate limits) stay tracked in [`tools-wishlist.md`](tools-wishlist.md) §2. | [`runner._build_cmd`](webapp/worker/src/strix_worker/runner.py), [`instruction.py`](webapp/worker/src/strix_worker/instruction.py). 21 unit tests pinning the contract. | M |

### 9.2 `repository` targets

Today: schema carries only `value` (URL). Strix clones the default branch and scans everything.

| | Field | What it controls | How to support | Effort |
|---|---|---|---|---|
| ⬜ | **`branch`** | Which ref Strix scans. Default `main` / `master` / `develop` is rarely what a security-conscious team wants ("scan staging"). | Worker clones to a per-scan workdir at the chosen ref, then points Strix at the local path. No Strix change needed. | S |
| ⬜ | **`subdirectory`** | Monorepo: scope to `apps/api/` or `services/billing/`. | Worker `cd`s to the subdir before invoking Strix. | S |
| ⬜ | **`path_excludes`** | Skip `node_modules/`, `vendor/`, `dist/`, `__pycache__/`, test fixtures. | Augment instruction. | S |
| ⬜ | **`language_hints`** (e.g. `["python", "typescript"]`) | Primes Strix's static-analysis tools. | Augment instruction. | S |
| ⬜ | **Public-fork mode** | Read-only scan of a public repo we don't own — agent must not attempt to write findings, open issues, or push branches. | Worker hides the GitHub-write integration when this flag is on. | S |

### 9.3 `web_application` targets — biggest coverage gap

Today: schema carries only `value` (URL). Strix crawls from the root, anonymously, with no rate-limiter. Most real apps live behind auth — the **logged-in surface is invisible to us**.

| | Field | What it controls | How to support | Effort |
|---|---|---|---|---|
| ⬜ | **`auth_strategy`** (`cookie` / `bearer` / `basic` / `oauth_creds`) + **`auth_credentials_secret_id`** | The agent scans the logged-in surface, not just public pages. **The single biggest coverage gap today** — without this, every authenticated app gets a partial scan. | Vault secret + per-strategy augmented instruction (Strix's docs already prescribe natural-language credential injection). Stretch: a Strix `--auth-cookie` / `--auth-bearer` CLI flag for clean handoff (wishlist). | M |
| ⬜ | **`crawl_seeds`** (list of URLs) | Start the crawl from `/login`, `/api`, `/admin` — not just `/`. | Augment instruction. Wishlist: `--seed-url` repeatable. | S |
| ⬜ | **`excluded_paths`** (glob list) | Don't hit `/api/billing/charge`, `/admin/destroy-account`, anything the user's prod can't safely receive twice. | Augment instruction + a hard wrapper-side egress check (sandbox iptables) so prompt-injection can't bypass. | M |
| ⬜ | **`api_spec_url`** (OpenAPI / Swagger) | Test every documented endpoint. | Augment instruction with the URL. | S |
| ⬜ | **`header_overrides`** (list of `"Name: value"`) | API-key auth, custom WAF bypass, `X-Forwarded-For`, etc. Sensitive ones go in Vault. | Augment instruction (non-sensitive) + Vault secret (sensitive). Wishlist: `--header` repeatable. | S |
| ⬜ | **`rate_limit_qps`** | "Don't exceed 10 req/s — production traffic." | Augment instruction. Strix needs a hard cap to actually honour this — wishlist `--rate-limit`. | M |

### 9.4 `domain` targets

Today: `value` + opt-in `auto_discover` (shipped).

| | Field | What it controls | How to support | Effort |
|---|---|---|---|---|
| ⬜ | **`subdomain_includes` / `subdomain_excludes`** (glob) | Even with auto-discover, "scan all `*.acme.com` except `*-staging.*`" or "only `api.*` and `app.*`". | Wrapper filters the discovery set + the per-scan `scan_targets` list. | S |
| ⬜ | **`dns_only`** flag | Just enumerate; don't probe HTTP. Useful for surface mapping without active probing. | Augment instruction. Wishlist: `--dns-only` Strix flag for cleaner gating. | S |

### 9.5 `ip_address` targets

Today: single IP. Strix decides ports + protocols — usually defaults to "the obvious ones", which is wrong both for narrow (an old IoT device on port 1900) and broad ("scan my office's whole /24") use cases.

| | Field | What it controls | How to support | Effort |
|---|---|---|---|---|
| ⬜ | **`port_spec`** (e.g. `80,443,1-1024,8080-8090`) | Which ports actually get probed. | Augment instruction. Wishlist: `--ports` Strix flag — `nmap` is what runs inside Strix anyway, so this is a thin wrapper. | S |
| ⬜ | **`protocols`** (`tcp` / `udp` / `both`) | UDP needs different scanning behaviour. | Augment instruction. | S |
| ⬜ | **CIDR / IP-range support** | Existing roadmap item. "Scan my office IP range `203.0.113.0/24`." | Schema validation update + worker fans out scan_targets per host (or passes the CIDR through if Strix can take it). | S |

### 9.6 `local_code` targets

Today: path. The SaaS-deployed worker can't access the user's filesystem — this type is effectively **self-host only**.

| | Field | What it controls | How to support | Effort |
|---|---|---|---|---|
| ⬜ | **`language_hints` / `path_excludes`** | Same as `repository`. | Same. | S |
| ⬜ | **Hide on managed deploys** | `local_code` should only be a selectable type when the worker has volume access. On the cloud product, hide it from `/targets/new`. | Detect from a `WORKER_HAS_LOCAL_VOLUMES` env flag (default off in cloud, on in self-host). | S |

### 9.7 Cross-target infrastructure

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **Subdomain auto-discovery (opt-in)** | Shipped in [`migration 015`](webapp/supabase/migrations/20260429000015_target_auto_discover.sql) — see §9.4 above for follow-on includes/excludes. | — | M |
| ⬜ | **GitHub org bulk-add.** "Connect your GitHub org → see every public repo + every private repo we have access to → tick the ones to scan." | A single click adds 30 targets. Catalyzes "I scanned everything" stories that drive virality. | After GitHub OAuth, fetch `/user/repos` and present a checklist. | M |
| ⬜ | **Recurring crawl-then-scan** for deployed web apps. Pre-scan polite crawl to enumerate endpoints before letting Strix loose. | Modern apps have hundreds of endpoints; the scanner shouldn't have to guess. Pairs with `crawl_seeds` (§9.3). | Pre-scan crawl phase in the worker; passes the discovered URL set into the instruction. | L |
| ⬜ | **Target health monitoring.** "Is this target up?" — DNS resolution + a single HEAD request before scanning. Surface failures clearly instead of failing 10 minutes in. | Saves $ + frustration. | Pre-flight check in the worker before spawning Strix. | S |
| ⬜ | **Per-target scan history retention.** SMB users want "last 90 days" not "since the dawn of time". | Storage cost. UX clarity. | Plan-tier-driven retention policy with archive-to-S3 for older runs. | M |
| ⬜ | **Tag / group targets.** "Production", "Staging", "Customer-facing", arbitrary user tags. Filter by tag. | Once a user has 30 targets, they need taxonomy. | New `tags` + `target_tags` tables. | S |

### 9.8 Strix-side flags this depends on

For the items above marked "wishlist", real CLI flags would beat instruction-text augmentation. Tracked in [`tools-wishlist.md`](tools-wishlist.md) under "Per-target-type CLI flags":

  - `--branch <ref>` (`repository`)
  - `--auth-cookie` / `--auth-bearer` / `--auth-basic` (`web_application`)
  - `--seed-url <url>` (repeatable, `web_application`)
  - `--exclude-path <glob>` (repeatable, `web_application`)
  - `--openapi <url>` (`web_application`)
  - `--header <name:value>` (repeatable, `web_application`)
  - `--rate-limit <qps>` (`web_application`)
  - `--dns-only` (`domain`)
  - `--ports <spec>` + `--protocol <tcp|udp|both>` (`ip_address`)

Until these land, augmented instruction text fills the gap — works for ~80% of cases, fragile for credentials and rate-limits where natural-language compliance isn't guaranteed.

---

## 10. Triage, remediation & continuous learning

Keep AI triage tight. SMB users have no patience for false positives. **The "learns from every triage" claim on the landing page lives or dies here.**

### Stateless triage (no human in loop)

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **Cross-scan finding deduplication.** Fingerprint-based collapse so the same finding across N scans is one row. | Massively reduces alert fatigue on rescans. | Foundation in [migration 010](webapp/supabase/migrations/20260428000010_finding_dedup_and_ai_assessment.sql); occurrence ledger + reopen-on-recurrence + UI surface in [migration 017](webapp/supabase/migrations/20260430000017_finding_occurrences.sql). | S |
| ✅ | **AI triage during the scan flow.** Triage logic extracted to [`triage.py`](webapp/worker/src/strix_worker/triage.py); `runner.run_scan` calls `triage_scan_findings` after `_upload_run_artifacts` and before `finish_scan`, so by the time the scan flips to `completed` every new finding already has an `ai_assessment`. Failures non-fatal; emits `triage.started` / `triage.completed` events for the live stream. The standalone `assess_findings.py` script is kept for backfill + `--reassess`. | Removes the manual step — the user-facing value of "I don't see false positives" now happens automatically on every scan. | [`runner.py`](webapp/worker/src/strix_worker/runner.py) + [`triage.py`](webapp/worker/src/strix_worker/triage.py) + [`assess_findings.py`](webapp/worker/scripts/assess_findings.py). | S |
| ✅ | **AI triage with codebase context (RAG).** Strix already extracts file path, line range, snippet, and a suggested-fix diff for every code finding (the `code_locations` field, serialised into the `## Code Analysis` markdown section). Stage A.0: parse that section back into structured form on ingest, persist as `findings.affected_files` JSONB, and consume the snippets directly in the triage prompt — no file IO, no JIT clone, works for repository + local_code uniformly. Stage A.1's local-disk fallback is retained for findings where Strix didn't supply structured data. Stage B (pgvector similarity for *related* code beyond what Strix cites) deferred — lower marginal value once we already have the agent's own snippets + fix proposal. | Improves precision from "good guess" to "high confidence". | [`code_context.parse_code_analysis_section`](webapp/worker/src/strix_worker/code_context.py) round-trips Strix's structured data; [`runner._ingest_finding`](webapp/worker/src/strix_worker/runner.py) persists it; [`triage.py`](webapp/worker/src/strix_worker/triage.py) injects snippets + fix diffs into the prompt as ground truth. | L (Stage B optional) |
| ⬜ | **Fix-suggestion autopilot.** When AI marks a finding `fix_now`, propose a draft PR with a candidate patch. Reviewer-approved, never auto-merged. | The closing of the loop: scan → triage → *fix*. | New worker job using the GitHub integration. Patch generation via the same LLM pipeline. | L |

### Reinforcement learning from triage (pillar 2)

The contract behind *"learns from every triage you do — so you never see the same false positive twice."* Every Fixed / Confirmed-real / False-positive / Won't-fix click on a FindingCard is a labeled training pair. Without the items below, those clicks vanish. Designed for **per-tenant isolation** — the loop never trains across orgs (privacy promise on the landing page).

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| ✅ | **Persisted triage as labeled training pairs.** Every triage decision becomes a row in `triage_signals` with `(finding_id, decision, prior_status, decided_at, decided_by, ai_prediction, finding_features, embedding, org_id)`. Postgres trigger fires only on user-initiated transitions (worker auto-flips filtered out by `auth.uid() is null` check), per-org RLS, backfill from existing triaged findings, embedding column populated alongside the finding embedding. | Without persistence, "the model gets sharper with use" is marketing. With it, every click is a gradient step. | [migration 018](webapp/supabase/migrations/20260501000018_triage_signals.sql) + [migration 019](webapp/supabase/migrations/20260502000019_triage_embeddings.sql). Per-org RLS; signals immutable; trigger is SECURITY DEFINER so authenticated users can't bypass it. | M |
| ✅ | **Per-org ranking model.** pgvector enabled, `embedding vector(768)` on both `findings` and `triage_signals`, worker computes embeddings (Gemini text-embedding-004, free tier on the same key as triage), trigger copies the embedding into the signal at insert time, `predict_triage_for_finding(uuid)` RPC does cosine-similarity KNN over this org's signals and returns `{n_neighbours, mean_similarity, p_false_positive, p_real}`. Per-org isolation enforced by SECURITY INVOKER + source-table RLS — cross-org queries return NULL by construction. **KNN over embeddings was chosen over a trained classifier (LR / GBT) for v1**: works from finding #1 (no minimum-data threshold), interpretable ("we said this because of these N neighbours"), no model lifecycle to manage. UI integration shipped in Phase 3 (confidence display, suggestions, auto-dismiss with 5% ε-greedy escape valve). | Per-tenant tuning is the differentiator. The blog post promises FP rate drops from 7% to <1% by week 4 — that only happens if a model learns the org's tolerances. | [migration 019](webapp/supabase/migrations/20260502000019_triage_embeddings.sql); embedding pipeline in [`triage.py`](webapp/worker/src/strix_worker/triage.py). | L |
| ✅ | **Triage suggestions ("we think this is FP — confirm?").** Phase 3a shipped: when `predict_triage_for_finding` returns `p_false_positive ∈ [0.70, 0.95)` for an open finding, the expanded `FindingCard` shows an amber suggestion banner with "Confirm — false positive" and "Override — it's real" buttons. Either click triggers a `findings.status` update which fires the migration-018 trigger and writes a labelled `triage_signals` row — the active-learning loop closing. | Saves clicks on routine cases; every Confirm/Override is a labeled training pair (active learning). | [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx) suggestion banner, gated by `predict_triage_for_finding` from migration 019. | M |
| ✅ | **Auto-dismiss high-confidence false positives.** Shipped in [migration 020](webapp/supabase/migrations/20260503000020_dismissed_by_ai.sql) + worker policy in [`triage.py`](webapp/worker/src/strix_worker/triage.py) `_maybe_auto_dismiss`. Four hard gates: `p_false_positive ≥ 0.95`, same-fingerprint precedent (the org has dismissed this fingerprint at least once), `severity != 'critical'` (catastrophe floor — never auto-dismiss critical regardless of confidence), and ε-greedy escape valve (5% of eligible auto-dismisses are surfaced anyway, audit-tagged `epsilon_explore: true`, to prevent filter-bubble drift). New `dismissed_by_ai` status (distinct from `false_positive`) makes the policy decision auditable; `auto_dismiss_reason` JSONB column carries the prediction snapshot. UI: full reasoning + one-click Restore button on the expanded card; dedicated **AI dismissed** filter tab. | The single biggest perceived-value improvement: the user never sees the FP at all. Reversibility is non-negotiable; the user must be able to override. | Worker: [`triage.py`](webapp/worker/src/strix_worker/triage.py) `_maybe_auto_dismiss`. UI: AI-dismissed banner + Restore button in [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx); new tab in [`findings-filter.tsx`](webapp/frontend/components/finding/findings-filter.tsx). | M |
| ⬜ | **Pattern → permanent suppression.** The model notices "this org always dismisses CWE-89 findings on `/api/internal/*`". Surface the pattern; offer one click to convert it into a real `finding_suppressions` rule (§6 row 6). | Closes the loop from "we noticed" to "you fixed the rule that made us notice". | Pattern detection job; UI prompt. Re-uses the suppression-rule schema. | M |
| ✅ | **Active learning prompts on borderline cases.** Subtle violet hint banner in the expanded `FindingCard` when `prediction.p_false_positive ∈ [0.4, 0.6]` AND `n_neighbours ≥ 5` (so we don't ping the user with "we're not sure" on the first finding of every kind). No action buttons — the existing triage row does the work; this is just signal that the user's call here is high-value feedback. | Targeted requests for human input where the marginal information gain is highest. | [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx) `showActiveLearningHint` block. | S |
| ✅ | **Confidence display + filter on every finding.** Expanded FindingCard now carries a small `Brain` badge in the metadata strip: *"AI: 73% likely FP · n=14"*, with a hover tooltip explaining the source ("vector similarity over your org's prior triage decisions, mean similarity 0.84"). Read from `predict_triage_for_finding` via lazy fetch on expand. The new "AI dismissed" filter tab in `FindingsFilter` is the surface for "high confidence only" / "needs review". | Honest UX. Lets the user calibrate their own trust in the model. | [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx) confidence badge + lazy fetch; new view-mode in [`findings-filter.tsx`](webapp/frontend/components/finding/findings-filter.tsx). | S |
| 🚧 | **Triage-drift detection.** Metric foundation shipped: `triage_drift_for_org()` RPC reads ε-greedy explore audit rows (the 5% sample of would-have-been auto-dismissed findings the policy intentionally surfaces) and computes the override rate. ε-explores are random samples from the would-have-dismissed population, so the override rate is an unbiased estimator of the auto-dismiss false-suppression rate — no separate eval job needed, the policy structure produces the signal continuously. UI surface: live "auto-dismiss accuracy" metric + drift-warning banner in Settings → AI triage learning when override rate exceeds 20%. Open: Slack/email alerting on drift_warning transitions. | A model that silently miscalibrates is worse than a stateless one. | [`triage_drift_for_org`](webapp/supabase/migrations/20260504000021_triage_controls.sql) + the *AI triage learning* section in [`settings-client.tsx`](webapp/frontend/app/(app)/settings/settings-client.tsx). | M |
| ✅ | **"Reset & retrain" controls.** `reset_triage_signals(p_keep_days int)` RPC: `null` = full wipe (cold start), `90` = keep last 90 days only (the typical "stack changed shape, retrain on recent signal" intervention). Owner+admin gated, `null not in (...)` bug-class explicitly handled with a `v_role is null` guard. UI: confirmation-modal flow in Settings → AI triage learning, button disabled when there are no signals. | Trust + control. | [`reset_triage_signals`](webapp/supabase/migrations/20260504000021_triage_controls.sql) + the trim/reset buttons in [`settings-client.tsx`](webapp/frontend/app/(app)/settings/settings-client.tsx). | S |
| ✅ | **Cross-finding triage history on the card.** "You've triaged N similar findings before — X dismissed, Y confirmed real." Lazy-fetched on card expand via `triage_history_for_finding` RPC (security-invoker, so RLS naturally enforces per-org isolation — cross-org leak impossible by construction). Phase 1 defines "similar" as same CWE + target; phase 2 will swap that for vector similarity without changing the UI shape. | Memory feels like a real engineer; gives the user context for their own decision. | [`triage_history_for_finding`](webapp/supabase/migrations/20260501000018_triage_signals.sql) + the *Your team's pattern* section in [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx). | S |

### AI security engineer surface (pillar 1)

Make the agent feel like a real security engineer, not a stack of regex matches. Every item below is about *how the work shows up* in the UI, not the work itself.

| | Item | Why | Where | Effort |
|---|---|---|---|---|
| 🚧 | **Agent specialisation labels.** Heuristic shipped: `inferAgentCategory` in [`agents-section.tsx`](webapp/frontend/components/scan/agents-section.tsx) scores each agent's tool-call pattern across six categories (Recon / Auth / Injection / SSRF / Web app / Code audit) and renders a coloured chip next to the status pill when the lead is meaningful (≥3 absolute, ≥1.5× runner-up). Falls back to no chip on noisy patterns. Tooltip on the chip flags it as heuristic. The clean upstream answer is `tools-wishlist.md` P0 *"Per-agent task category tag"* — when Strix attaches `category` to `agent.created.payload`, the heuristic becomes a fallback. | "An AI security engineer" feels real when the team has named roles. Generic "Investigator #3" doesn't. | Wrapper-side heuristic now; deterministic upstream tag later. | S |
| 🚧 | **Multi-step kill-chain narrative.** New `kill_chain_for_finding(p_finding_id)` RPC ([migration 023](webapp/supabase/migrations/20260506000023_kill_chain.sql)) returns the chronological `tool.execution.started` + `chat.message` events from the 5-minute window before the finding was filed, optionally same-agent-filtered when Strix's `actor.agent_id` is present. New `KillChainSection` in [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx) renders it as a numbered timeline with violet/cyan dots distinguishing reasoning vs action steps. UI labels it *"approximate"* — the deterministic version awaits the wishlist P4 ask (`agent_id` on every tool event); when that lands the heuristic becomes deterministic without UI changes. | Differentiates from pattern-matchers. Shows real adversarial thinking. | RPC + lazy-fetched component; SECURITY INVOKER so RLS handles cross-org isolation. | M |
| ⬜ | **PoC verification badge.** Every finding marked "verified" if the agent ran an exploit that actually triggered. *"PoC ran — vulnerable response captured."* vs *"Pattern match — not verified."* Big visual difference on the card. | The "real vulnerabilities, not noise" promise hinges on this distinction. Verified findings should look unmistakably different. | Schema: `findings.verification_status`. Set during scan based on tool-call outcomes. UI badge. | M |
| ⬜ | **Negative coverage assertions.** "We tested `/api/auth` for SQLi, IDOR, and broken session — clean." Most scanners list only what they found; we should list what we tested *and didn't* find. | A scan that returns 0 findings looks like the scanner failed; a scan that returns 0 findings *plus a coverage report* looks like a clean bill of health. | Some upstream ask ([tools-wishlist.md](tools-wishlist.md) §0 *Semantic checkpoint events*); some derivable today from tool calls + endpoints touched. | M |
| ✅ | **Cross-scan memory ("last scan we saw X here").** Two surfaces shipped: (1) scan-page roll-up "Re-checked from prior scans: still active / fixed / dismissed / reopened" via `scan_recurrence_summary(p_scan_id)` RPC over `finding_occurrences` + `findings`; (2) per-finding triage prompt now carries an exact-fingerprint priors block via the new `triage_priors_for_finding(p_finding_id)` RPC + `_format_triage_priors` in `triage.py`. The KNN model handles similarity-based signal; this RPC is the orthogonal "what has the user decided on *this exact* fingerprint" question — much stronger when present. | Real engineers remember. Stateless tools forget. | [migration 022](webapp/supabase/migrations/20260505000022_scan_summary_and_recurrence.sql) + `triage.py` priors injection + new section in [`scans/[id]/page.tsx`](webapp/frontend/app/(app)/scans/[id]/page.tsx). | M |
| ⬜ | **Hand-off to a human.** A "request human review" button on any finding. Routes to a paid-tier service (us — or eventually a marketplace of contractors). | Some findings need a human. Owning the hand-off keeps users in the product instead of bouncing to Burp / contractor / consultancy. | New table `review_requests`; admin queue; pricing tier. | L |
| ✅ | **Plain-language scan summary at the top.** Worker generates a two-paragraph summary post-triage via `summary.py` `summarize_scan`, persists to `scans.summary` JSONB. UI renders above the live view on the scan detail page with the AI gradient brand mark. **Calibrated honest tone**: the prompt explicitly forbids "tested for X — clean" claims (no upstream `check.completed` events yet) and uses "exploit drafted" not "verified" (no upstream verification bool yet). The wishlist's P1 `run.summary` upstream event is the eventual upgrade path — when it lands, swap the LLM call for a parse without changing the UI. | The 30-second summary is what the security-minded staff engineer forwards to their team chat. | [`summary.py`](webapp/worker/src/strix_worker/summary.py) writes JSONB; the *Scan summary* section in [`scans/[id]/page.tsx`](webapp/frontend/app/(app)/scans/[id]/page.tsx) renders it. | S |

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

## 19. ClatTribe/strix integration backlog (wrapper-wishlist gap-closure)

The fork at [`ClatTribe/strix`](https://github.com/ClatTribe/strix) ships a substantially richer engine than upstream. [`wrapper-wishlist.md`](wrapper-wishlist.md) (16 sections, written *by* the engine team *for* this wrapper) catalogues every integration gap. [`usage.md`](usage.md) is the operating manual. **Most of the engine's structured signals are not yet consumed here** — we re-derive them with wrapper-side heuristics. Per the doctrine in [`Architecture.md` §1.1](Architecture.md#11-design-principles), the engine's deterministic signal should be the primary input; wrapper heuristics should be fallbacks.

The catalog below is grouped by tier. Tier 0 is ops; tier 1 is "read what the engine writes"; tier 2 is "close the FP feedback loop"; tier 3+ is feature surface area.

### 19.0 Tier 0 — ops (gates everything)

| | Item | Why | Effort |
|---|---|---|---|
| ⬜ | **Rebuild sandbox image from the fork.** [`wrapper-wishlist.md` §6](wrapper-wishlist.md#6-required-rebuild-the-sandbox-image). Fork registers 8 new recon tools (`subdomain_enum`, `discover_cloud_assets`, `reverse_ip_discovery`, `code_search_for_domain`, `mx_fingerprint`, `subdomain_takeover_check`, `saas_leak_discovery`, `domain_recon_pipeline`, `spawn_webapp_subteam`) with `sandbox_execution=True`. Without the rebuild, the agent inside the container sees "tool not found" for everything new. | Without this, every Tier 1+ item is silently degraded — no findings can land that depend on the new tools. | XS (ops) |

### 19.1 Tier 1 — Read what the engine already writes

This tier is the **integration contract closure**. ~12 dev-days for the whole tier per the wishlist's own §7 estimate. Each item below is independently shippable.

| | Item | Engine signal | Where in webappsec |
|---|---|---|---|
| ✅ | **Read `vulnerabilities.json` directly** instead of parsing per-vuln markdown. Worker prefers the engine's structured artifact (`_ingest_findings_from_json`); markdown is the fallback for older engines. Migrations 024 + 025 + 029 added 23 nullable columns covering the entire §15.3 + §10 quality surface — `confidence`, `reasoning_trace`, `counter_proof`, `reproducibility_token`, `category`, `priority_label`, `verification_status`, `description_plain`, `recommended_action`, `compliance_controls`, `data_classification`, `mitre_attack`, `owasp_top_10`, `owasp_api_top_10`, `is_canonical`, `features`, `kill_chain`, `engine_auto_dismissed`, `severity_pre_auto_dismissal`, `prior_label_attribution`, `trajectory`. Highest leverage single PR in the backlog — turned out to be PR #42. | [`wrapper-wishlist.md` §15.3](wrapper-wishlist.md#153-finding-quality-signals-engine-137); [engine PR #137](https://github.com/ClatTribe/strix/pull/137); [`usage.md` §2.3](usage.md#23-reading-vulnerabilitiesjson-the-finding-stream). | [migrations 024](webapp/supabase/migrations/20260507000024_engine_finding_signals.sql) + [025](webapp/supabase/migrations/20260507000025_worker_insert_finding_engine_signals.sql) + [`runner.py`](webapp/worker/src/strix_worker/runner.py) `_ingest_findings_from_json`. | M |
| ✅ | **Read `run_summary.json`** at scan finalize. `summary.py` `_read_engine_run_summary` reads the artifact from the workdir and `_normalize_engine_summary` converts the engine's shape to the existing `scans.summary` JSONB shape (so the UI renders unchanged). LLM call only runs as a fallback when the engine artifact is absent. Tagged `source: "engine_run_summary_json"` on the row so future drift-detection can distinguish authored sources. | [§2.1](wrapper-wishlist.md#21-run_summaryjson-31); [engine PR #31](https://github.com/ClatTribe/strix/pull/31). | [`summary.py`](webapp/worker/src/strix_worker/summary.py). | S |
| ✅ | **Consume `target.started` / `target.completed` events** for per-target progress chips on the scan page. Each row in the Targets section now carries a status chip (running spinner / done with finding count) read from the engine's per-target events. | [§3.1](wrapper-wishlist.md#31-targetstarted--targetcompleted-32); [engine PR #32](https://github.com/ClatTribe/strix/pull/32). | [`scans/[id]/page.tsx`](webapp/frontend/app/(app)/scans/[id]/page.tsx) `parseTargetEvents`. | S |
| 🚧 | **Consume `run.test_plan` event** to render a checklist of planned categories before findings exist. The plan checklist now renders on the scan page, including the engine's `summary_text`, per-target planned categories with descriptions, and `dns_only` / `scan_mode` badges. **Wrapper-side work complete; the remaining tick-off-as-completed UX is blocked upstream** — engine doesn't yet emit `check.completed` events (open as wishlist P0 in upstream strix). When that lands, the existing checklist renderer just needs to subscribe to the new event type. | [§3.2](wrapper-wishlist.md#32-runtest_plan-35); [engine PR #35](https://github.com/ClatTribe/strix/pull/35). | [`scans/[id]/page.tsx`](webapp/frontend/app/(app)/scans/[id]/page.tsx) `parseTestPlan`. | S |
| ✅ | **Consume `agent.created.payload.category`** instead of running our heuristic. `agents-section.tsx` reads `payload.category` from each `agent.created` event; `mapEngineAgentCategory` maps known engine tags (`auth-attacker`, `ssrf-scanner`, etc.) to our six-bucket `AgentCategory`. Unknown engine tags render with a generic neutral chip showing the raw role string. Heuristic `inferAgentCategory` is the fallback. | [§3.4](wrapper-wishlist.md#34-agentcreatedpayloadcategory-33); [engine PR #33](https://github.com/ClatTribe/strix/pull/33). | [`agents-section.tsx`](webapp/frontend/components/scan/agents-section.tsx). | XS |
| ✅ | **Consume `finding.kill_chain` events** instead of running our 5-minute time-window heuristic. `findings.kill_chain` JSONB is populated by the PR #42 ingest path (read from `vulnerabilities.json`). New `EngineKillChainSection` component renders the structured chain with the 7-value type → icon mapping (recon 🔍 / discovery 📋 / exploitation 💥 / escalation 🔐 / lateral_movement 🔀 / impact ☠️ / validation ✓). Heuristic `KillChainSection` only fetches when engine data is absent — saves an RPC round-trip on every expand. | [§3.5](wrapper-wishlist.md#35-findingkill_chain-36); [engine PR #36](https://github.com/ClatTribe/strix/pull/36). | [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx). | S |
| ✅ | **Wire new finding categories**: `email_security` / `dns_security` / `secret_leak` / `vulnerable_dependency` / `authentication_bypass` plus the full web-app taxonomy (`sqli` / `xss` / `cmd_injection` / `ssrf` / `auth` / `authz` / `idor` / `crypto` / `csrf` / `path_traversal` / `misconfig` / `race_condition` / `open_redirect`) with per-category icon + label + colour token in `finding-theme.ts` `CATEGORY_THEME`. `getCategoryTheme` falls back to a neutral chip on unknown strings. FindingCard's metadata strip uses the icon+label pill instead of the raw category string. | [§4](wrapper-wishlist.md#4-new-finding-categories-to-map). | [`finding-theme.ts`](webapp/frontend/lib/finding-theme.ts) + [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx). | S |
| ✅ | **Add API-key fields to org settings**: `STRIX_GITHUB_TOKEN`, `STRIX_BING_KEY`, `STRIX_SECURITYTRAILS_KEY`, `STRIX_VIRUSTOTAL_KEY`, `STRIX_VIEWDNS_KEY`. Migration 028 adds `org_secrets` (org_id, key, vault secret_id pointer) with admin-only RLS + `worker_decrypt_org_secrets` RPC; new `/api/orgs/[id]/secrets` PUT/DELETE route audits via `audit_log`; settings UI's `ApiKeysSection` lists all 5 keys with per-provider signup links + free-tier hints; worker decrypts at scan-start and `_build_env` merges into the sandbox env (allowed-key frozenset enforced). Each key unlocks coverage: code-search recon, SaaS-leak discovery, passive DNS history (preferred + fallback), reverse-IP secondary. | [§5](wrapper-wishlist.md#5-new-api-keys-to-surface-in-org-settings). | [migration 028](webapp/supabase/migrations/20260510000028_org_secrets.sql) + [API route](webapp/frontend/app/api/orgs/[id]/secrets/route.ts) + `ApiKeysSection` in [`settings-client.tsx`](webapp/frontend/app/(app)/settings/settings-client.tsx) + `decrypt_org_secrets` in [`runner.py`](webapp/worker/src/strix_worker/runner.py). | M |
| ✅ | **`--dns-only` UI toggle** on new-scan form for `domain` targets. Migration 026 adds `scans.dns_only` boolean; new-scan form shows a *"Surface-map only"* checkbox when target type is domain; API route plumbs through to `create_scan_with_targets(p_dns_only)`; worker's `_build_env` forwards `STRIX_DNS_ONLY=1` into the sandbox; scan-page header renders a `passive` badge after-the-fact. | [§1.3](wrapper-wishlist.md#13-new-cli-flag---dns-only-30); [engine PR #30](https://github.com/ClatTribe/strix/pull/30). | [migration 026](webapp/supabase/migrations/20260508000026_dns_only_and_preflight.sql) + form + API + worker + scan page. | XS |
| ✅ | **`--preflight` failure UX.** Migration 026 adds `scans.preflight_failed` column; scan-page renders an amber "Target unreachable" banner when set. Worker now captures the tail of stderr in a 16 KiB ring buffer (`StderrTailBuffer`) and pattern-matches the engine's preflight diagnostic (`preflight…fail/could not/did not/unreachable`, ANSI-stripped) only on real failure exits — successful "preflight passed" scans never trip the flag. New `worker_set_preflight_failed` RPC (migration 029) gives the service-role worker a scoped writer. Conservative regex avoids the workdir-absence heuristic's false-positives. | [§1.1](wrapper-wishlist.md#11---preflight-defaults-on-29); [engine PR #29](https://github.com/ClatTribe/strix/pull/29) + [#30](https://github.com/ClatTribe/strix/pull/30). | [migration 026](webapp/supabase/migrations/20260508000026_dns_only_and_preflight.sql) + [migration 029](webapp/supabase/migrations/20260511000029_finding_trajectory.sql) + `StderrTailBuffer` in [`runner.py`](webapp/worker/src/strix_worker/runner.py) + scan-page banner. | XS |

### 19.2 Tier 2 — Close the FP feedback loop (RLHF Phase 1)

After Tier 1, the engine and wrapper become a *closed loop*. **Until this lands, every triage decision the user makes is invisible to the engine** — the next scan re-emits the same FPs.

| | Item | Engine signal | Where in webappsec |
|---|---|---|---|
| ✅ | **Write `feedback.jsonl`** for the engine's FP feedback loop. The migration-018 trigger already captures every user triage as a `triage_signals` row; on scan start the worker queries `worker_feedback_jsonl_for_org(p_org_id)` (new in migration 027), which transforms the org's labels into the engine's schema (closed-enum `verdict` + `fp_reason`, ISO-8601 `labeled_at`, labeler attribution from `auth.users` + `org_members` role), writes to `<run_dir>/feedback.jsonl`, and forwards both `--feedback-from <path>` and `STRIX_FEEDBACK_FROM=<path>`. Wrapper `triage_signals.fp_reason` column added (engine's 13-value closed enum). When user picks `wont_fix`, defaults to `compensating_control`; `false_positive` defaults to `other`. **The active-learning loop is closed end-to-end:** wrapper-DB labels → engine sees them → engine auto-dismisses on next scan. | [§15.1](wrapper-wishlist.md#151-closed-fp-feedback-loop-engine-142); [engine PR #142](https://github.com/ClatTribe/strix/pull/142); [`usage.md` §4](usage.md#4-wrapper-side-writeback--closing-the-fp-loop). | [migration 027](webapp/supabase/migrations/20260509000027_fp_feedback_loop.sql) + [`runner.py`](webapp/worker/src/strix_worker/runner.py) `_write_feedback_jsonl`. | M |
| ✅ | **Render `finding.auto_dismissed` events** with `prior_label_attribution`. New slate banner on the FindingCard's expanded view shows the labeler's id + the original `fp_reason` (or `verdict`) + the date the prior decision was made. "Force-show — this one's different" button flips status to `triaged_real`, which fires the migration-018 trigger and lands a `verdict=tp` signal that the next scan's `feedback.jsonl` carries to the engine — the override propagates back via the same loop. Distinct from the wrapper-side `dismissed_by_ai` banner (KNN-driven) so users can tell which automation made which decision. | [§15.1](wrapper-wishlist.md#151-closed-fp-feedback-loop-engine-142); [engine PR #142](https://github.com/ClatTribe/strix/pull/142). | [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx) "Engine auto-dismissed" banner. | M |
| ✅ | **`STRIX_FP_AUTO_DISMISS` policy switcher in org settings.** New `organizations.fp_auto_dismiss_policy` column (default `conservative`); admin-gated radio-group section in Settings; worker reads via `_resolve_fp_policy` and forwards as `STRIX_FP_AUTO_DISMISS=<value>` env on every scan. Inline descriptions of when each policy fires. | [§15.1](wrapper-wishlist.md#151-closed-fp-feedback-loop-engine-142); [`usage.md` §4.4](usage.md#44-auto-dismiss-policy-gate). | [migration 027](webapp/supabase/migrations/20260509000027_fp_feedback_loop.sql) + `FpAutoDismissSection` in [`settings-client.tsx`](webapp/frontend/app/(app)/settings/settings-client.tsx). | XS |
| ✅ | **Reasoning trail viewer powered by `trajectory.jsonl`** per finding. Worker reads `<run_dir>/trajectory.jsonl` after exit, keys by `finding_id`, attaches the matching record to each finding's payload — the full record (events_compact, iterations_to_emit, time_to_emit_seconds, dismissed_alternatives, exploration_breadth) lands in the new `findings.trajectory` JSONB column (migration 029). FindingCard renders a `TrajectorySection` with a header pill row (with "engine struggled" amber tint when iterations ≥ 30 or emit ≥ 60s), a numbered tool-call timeline with provenance badges, and a "What we ruled out" sub-section listing dismissed alternatives with reasons. Hidden when the engine didn't write a trajectory. | [§15.1](wrapper-wishlist.md#151-closed-fp-feedback-loop-engine-142); [engine PR #142](https://github.com/ClatTribe/strix/pull/142). | [migration 029](webapp/supabase/migrations/20260511000029_finding_trajectory.sql) + `_load_trajectories` in [`runner.py`](webapp/worker/src/strix_worker/runner.py) + `TrajectorySection` in [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx). | M |

### 19.3 Tier 3 — Provenance + hypothesis live view

| | Item | Engine signal | Where |
|---|---|---|---|
| ✅ | **Render `actor.provenance` badges on every tool call.** Each tool-call row in the per-agent panel inside `behind-the-scenes` now carries a coloured chip from the 6-value enum — green for `trusted_source` / `intel_feed`, rose for `target`, amber for `operator_input` / `mixed`, neutral for `framework`. Hover-tooltip explains the trust class. The badge plus its dot-dot accent reads as a quick "is this output adversary-controlled or wrapper-internal?" signal without expanding any further state. | [§15.5](wrapper-wishlist.md#155-tool-output-provenance--trust-taint-engine-139); [engine PR #139](https://github.com/ClatTribe/strix/pull/139). | `PROVENANCE_THEME` + `AgentToolCall.provenance` in [`security-review.tsx`](webapp/frontend/components/scan/security-review.tsx). | S |
| ✅ | **Active-hypothesis live pane.** New `HypothesisPane` consumes `hypothesis.opened` / `hypothesis.confirmed` / `hypothesis.dismissed` events from the live event stream and renders the rolling open-hypothesis list as the primary block (with surface, category, agent, hypothesis text, "X ago" relative time). Confirmed and dismissed hypotheses fold into collapsible groups beneath; confirmed rows expose a "see finding →" deep-link to `#finding-<id>` (FindingCard now carries the matching anchor + scroll-mt offset). Defensive against out-of-order events (confirmed is treated as terminal — a late `dismissed` for the same id is ignored). | [§15.4](wrapper-wishlist.md#154-active-hypothesis--agent-self-audit-engine-138--140); [engine PRs #138](https://github.com/ClatTribe/strix/pull/138) + [#140](https://github.com/ClatTribe/strix/pull/140). | New [`hypothesis-pane.tsx`](webapp/frontend/components/scan/hypothesis-pane.tsx) wired into [`scan-live-view.tsx`](webapp/frontend/components/scan/scan-live-view.tsx); finding-card anchor in [`finding-card.tsx`](webapp/frontend/components/finding/finding-card.tsx). | M |
| ✅ | **Per-phase coverage receipt.** New `PhaseProgress` component on the scan page renders the four canonical phases (recon → exploit → validate → report) as a horizontal strip. Each tile shows pending / in-progress / done status, the engine's `categories_covered` chips, and `categories_skipped` + `concern` are surfaced in a dedicated amber gate-breach banner below the strip — so "did the engine actually cover a full phase set?" has a yes/no answer at a glance. Hidden when no `phase.entered` events have arrived (older engines / pre-recon scans). Defensive against engines emitting non-canonical phase names. | [§15.5](wrapper-wishlist.md#155-tool-output-provenance--trust-taint-engine-139); [engine PR #140](https://github.com/ClatTribe/strix/pull/140). | New [`phase-progress.tsx`](webapp/frontend/components/scan/phase-progress.tsx) wired into [`scan-live-view.tsx`](webapp/frontend/components/scan/scan-live-view.tsx). | S |
| ✅ | **Indirect-prompt-injection alert** when a downstream tool consumes output from an upstream `target`-provenance tool. `detectPromptInjectionChain` scans each agent's tool-call history; the *first* `target → non-target/non-mixed` crossing renders an amber slate at the top of that agent's tool-call list naming both endpoints of the boundary crossing. Conservative — `target → target` and any `mixed` downstream are intentionally not flagged (the former is just continuing engagement; the latter already implies awareness). Pairs with future engine #84 sanitisation. | [§15.5](wrapper-wishlist.md#155-tool-output-provenance--trust-taint-engine-139); [engine PR #139](https://github.com/ClatTribe/strix/pull/139). | `detectPromptInjectionChain` in [`security-review.tsx`](webapp/frontend/components/scan/security-review.tsx). | M |

### 19.4 Tier 4 — Compliance / GRC / B2B surface (engine §14)

Largest commercial surface area. Engine has shipped extensive compliance artifacts; wrapper has rendered none of them.

| | Item | Engine signal | Where |
|---|---|---|---|
| ✅ | **Compliance evidence pack via `--compliance-pack <tmp>`.** Worker passes the flag on every scan; engine writes the 8-file auditor bundle (manifest, control_attestation, coverage_attestation, findings.csv, signed events excerpt, run_meta, SHA256SUMS) into `<workdir>/compliance_pack/<run_id>/`. After the run, `_upload_compliance_pack` walks the directory, uploads each file to scan-artifacts at `<org_id>/<scan_id>/compliance_pack/...` with auditor-friendly content-types (json / csv / md / jsonl preview inline), and flips `scans.compliance_pack_uploaded=true` (migration 030) when at least one file landed. The scan-page header renders a violet "Download compliance pack" CTA when the flag is set; clicking hits `/api/scans/[id]/compliance-pack`, which lists the storage prefix, builds a deflate zip in memory with JSZip, audit-logs the download, and streams the response with `<run-name>-<scan-date>-compliance-pack.zip` as the filename. Per-file failures are logged but skipped — partial auditor evidence is more useful than no evidence. **Single biggest B2B-sale unlock — turns "trust me, the engine ran" into a literal hand-it-to-compliance artifact.** | [§14.4](wrapper-wishlist.md#144-compliance-evidence-pack-engine-129); [engine PR #129](https://github.com/ClatTribe/strix/pull/129). | [migration 030](webapp/supabase/migrations/20260512000030_compliance_pack.sql) + `_upload_compliance_pack` in [`runner.py`](webapp/worker/src/strix_worker/runner.py) + [API route](webapp/frontend/app/api/scans/[id]/compliance-pack/route.ts) + scan-page CTA. | M |
| ✅ | **Vendor-risk score gauge** on every target. Worker persists the engine's `run_meta.json` verbatim into `scans.run_meta` JSONB (migration 031); `VendorRiskGauge` reads `run_meta.vendor_risk` and renders a 0-100 score with colored band (engine `band` field preferred; threshold-based fallback for older engines). Top 3 deduction categories sort by absolute magnitude and render below the score bar with the engine's `recommendation` text. Hidden when run_meta is absent or the score field isn't a finite number. Hero widget on the scan page, side-by-side with the MFA badge on wide screens. | [§14.8](wrapper-wishlist.md#148-vendor-risk-score-engine-133); [engine PR #133](https://github.com/ClatTribe/strix/pull/133). | [migration 031](webapp/supabase/migrations/20260513000031_run_meta.sql) + `_persist_run_meta` in [`runner.py`](webapp/worker/src/strix_worker/runner.py) + new [`vendor-risk-gauge.tsx`](webapp/frontend/components/scan/vendor-risk-gauge.tsx). | S |
| 🚧 | **SBOM viewer + diff.** New `/scans/[id]/sbom` page with a sortable, filterable, searchable CycloneDX 1.5 table. Worker flag (migration 032 / `scans.sbom_uploaded`) keys the "View SBOM" + "Download CycloneDX" CTAs in the scan-page header off whether the engine emitted an `sbom.cdx.json` (engine PR #131). API route `/api/scans/[id]/sbom` recursively walks the storage prefix to find the file, returns parsed JSON for the viewer or raw `application/vnd.cyclonedx+json` with auditor-friendly filename when `?format=cyclonedx`. Each row shows name + purl + version + type + license + scope + detected_via + a "vuln" badge derived from CycloneDX `vulnerabilities[].affects[].ref`. Type-filter chips and free-text search filter client-side; column headers toggle ascending/descending sort. **Open: cross-run diff** (rows added / version changed / new vulnerability) — needs the prior scan's SBOM as comparison input; defer to a follow-up. **OSV/GHSA enrichment** also defer (wishlist §14.6 row 2). | [§14.6](wrapper-wishlist.md#146-sbom-engine-131); [engine PR #131](https://github.com/ClatTribe/strix/pull/131). | [migration 032](webapp/supabase/migrations/20260514000032_sbom.sql) + [API route](webapp/frontend/app/api/scans/[id]/sbom/route.ts) + new [SBOM page](webapp/frontend/app/(app)/scans/[id]/sbom/page.tsx) + [`sbom-client.tsx`](webapp/frontend/app/(app)/scans/[id]/sbom/sbom-client.tsx) + scan-page CTAs. | M |
| ✅ | **MFA-posture badge** with hover-breakdown of the 4-point score (login_tokens / challenge_keys / webauthn_header / mfa_setup_paths). `MfaPostureBadge` reads `run_meta.mfa_attestation` from the same migration-031 JSONB; renders the score as an X/4 fraction inside an emerald/amber/rose band (≥1.0 / ≥0.5 / <0.5 ratio). Each breakdown key renders as a present/absent chip; unknown keys (future engine drift) render with their snake_case label. The card includes a copy-to-clipboard auditor attestation line ("MFA posture: 3/4 (partial) — engine PR #132 attestation.") so the operator can paste it directly into the auditor's questionnaire. Hidden when run_meta is absent. | [§14.7](wrapper-wishlist.md#147-mfa-attestation-engine-132); [engine PR #132](https://github.com/ClatTribe/strix/pull/132). | [migration 031](webapp/supabase/migrations/20260513000031_run_meta.sql) + new [`mfa-posture-badge.tsx`](webapp/frontend/components/scan/mfa-posture-badge.tsx). | S |
| ✅ | **Compliance overlay panel** with toggle (PCI / SOC2 / HIPAA / ISO 27001 / NIST 800-53 + GDPR + OWASP). New `ComplianceOverlay` component on the scan page reads each finding's engine-emitted `compliance_controls` JSONB (migration 024 / PR #42) and groups by framework × control. Framework tab strip hides empty frameworks; per-control rows are severity-sorted (worst-first) with a severity chip, expandable to the matching findings; each finding row deep-links to `#finding-<id>` so one click jumps from "show me PCI 8.2 findings" to the casefile. Collapsed by default — appears beneath the flat severity-sorted findings list so the primary read stays focused. Hidden entirely when no findings carry a `compliance_controls` mapping. Pairs with the new `CompliancePostureCard` hero widget (reads `run_meta.compliance_posture` — cadence_status / audit_log_retention_days / days_since_last_scan from migration 031) for the auditor "is this engagement on cadence?" question. | [§14.4](wrapper-wishlist.md#144-compliance-evidence-pack-engine-129) + [§10](wrapper-wishlist.md#10-zero-fp-rendering--surface-the-engines-deterministic-signals) + [engine PR #103](https://github.com/ClatTribe/strix/pull/103). | New [`compliance-overlay.tsx`](webapp/frontend/components/scan/compliance-overlay.tsx) wired into [`scan-live-view.tsx`](webapp/frontend/components/scan/scan-live-view.tsx); new [`compliance-posture-card.tsx`](webapp/frontend/components/scan/compliance-posture-card.tsx) wired into [`scans/[id]/page.tsx`](webapp/frontend/app/(app)/scans/[id]/page.tsx). | M |
| ⬜ | **Audit-trail verification UI.** Operator pastes/uploads `events.jsonl` + `run.signature.json` + signing key; wrapper verifies chain integrity + signature against the chain terminal hash. Surfaces tampering with line-level diff. | [§14.2](wrapper-wishlist.md#142-cryptographically-signed-audit-trail-engine-127); [engine PR #127](https://github.com/ClatTribe/strix/pull/127). | New verification page. | M |
| ⬜ | **Legal-document compliance card** per target (privacy / cookie / terms / DPA / imprint / accessibility presence). | [§14.1](wrapper-wishlist.md#141-legal-document-presence-engine-126); [engine PR #126](https://github.com/ClatTribe/strix/pull/126). | Per-target compliance dashboard. | S |
| 🚧 | **Monitoring-posture gauge.** New `MonitoringPostureBadge` reads `run_meta.monitoring_posture` (already persisted by migration 031) and renders a 0-6 score with band-from-ratio (≥1.0 mature emerald / ≥0.5 partial amber / <0.5 weak rose). Each axis from the engine's breakdown (PII redaction, secrets redaction, auth-token redaction, CSP report-uri, error pipeline, rate-limit observability) renders as an eye/eye-off chip. The recommendation text from the engine renders below. Joined to the hero strip alongside vendor-risk + MFA + compliance posture. **Open: CSP-with-report-uri auto-generator** when `csp_reporting` is missing — wishlist §14.3 row 2; deferred to a follow-up because the wrapper-hosted `report-uri` endpoint is its own piece of infrastructure. | [§14.3](wrapper-wishlist.md#143-logging--monitoring-posture-engine-128); [engine PR #128](https://github.com/ClatTribe/strix/pull/128). | New [`monitoring-posture-badge.tsx`](webapp/frontend/components/scan/monitoring-posture-badge.tsx); typed `MonitoringPosture` in [`types.ts`](webapp/frontend/lib/supabase/types.ts). | M |
| ⬜ | **GRC SaaS one-click upload.** Operator picks Vanta / Drata / Hyperproof / Secureframe / ServiceNow; wrapper calls strix with `--export-format <platform>`, POSTs to platform's import endpoint. | [§14.5](wrapper-wishlist.md#145-grc-saas-exports-engine-130); [engine PR #130](https://github.com/ClatTribe/strix/pull/130). | Wrapper integration layer per platform. | M |

### 19.5 Tier 5 — CLI flags + ergonomics

Small UI affordances for engine flags that already exist.

| | Item | Engine signal | Effort |
|---|---|---|---|
| 🚧 | **Branch picker on repository scan.** New free-text `Branch` input on the new-scan form, shown only when the selected target is `repository`-typed. Migration 033 adds `scans.branch text` and bumps `create_scan_with_targets` to an 11-arg signature with `p_branch` (drops the prior 10-arg overload to avoid PGRST203 ambiguity). API route forwards the value (zod-trimmed, ≤255 chars, server-side `nullif(trim())` defence-in-depth in the RPC). Worker `_build_cmd` adds `--branch <ref>` when set, with a final `.strip()` so a stray space can't break shell escape. Empty value lets the engine fall back to the repo's default branch. **Open: a full GitHub-API-sourced dropdown** that enumerates refs — needs a connected GitHub integration; deferred. | [§13.3](wrapper-wishlist.md#133-cli--operator-ergonomics-engine-117-121-123-124); [engine PR #117](https://github.com/ClatTribe/strix/pull/117). | [migration 033](webapp/supabase/migrations/20260515000033_scan_branch.sql) + [`runner.py`](webapp/worker/src/strix_worker/runner.py) + [API route](webapp/frontend/app/api/scans/route.ts) + [new-scan form](webapp/frontend/app/(app)/scans/new/page.tsx). | XS |
| ✅ | **CIDR target preview.** New-scan form renders an amber host-count chip on every `ip_address` target whose value parses as a CIDR. `previewCidrHosts` accepts both IPv4 (/0–/32, exact host count) and IPv6 (/0–/128, with scientific-notation truncation past ~4 billion hosts so a /48 doesn't render 2^80 digits). The chip lets operators see "/24 = 256 hosts" *before* launching a scan that could fan out probes across the whole CIDR. | [§13.3](wrapper-wishlist.md#133-cli--operator-ergonomics-engine-117-121-123-124); [engine PR #124](https://github.com/ClatTribe/strix/pull/124). | XS |
| ⬜ | **`--quiet` / CI mode preset** with copy-pasteable GitHub Actions / GitLab CI snippet generator. | [§13.3](wrapper-wishlist.md#133-cli--operator-ergonomics-engine-117-121-123-124); [engine PR #121](https://github.com/ClatTribe/strix/pull/121). | S |
| ⬜ | **"Recon nightly, scan daily" workflow template.** `--surface-map-only` cron + targeted scans against discovered surface daily. | [§13.3](wrapper-wishlist.md#133-cli--operator-ergonomics-engine-117-121-123-124); [engine PR #123](https://github.com/ClatTribe/strix/pull/123). | M |
| ⬜ | **Cancel button → SIGTERM.** Trust the engine's `run.cancelled` event + 143 exit. Status card flips to "cancelled" with no half-written state. | [§13.1](wrapper-wishlist.md#131-resilience--cost-gating-engine-112-113-114); [engine PR #114](https://github.com/ClatTribe/strix/pull/114). | S |
| ✅ | **Live "upstream rate-limited" banner** on `llm.retry_attempted` events. New `UpstreamRetryBanner` sits at the top of `ScanLiveView` and reads the most-recent retry event from the live event stream; renders attempt N/M, HTTP status code, error type, and a 1-second-tick ETA countdown derived from `wait_seconds` minus elapsed-since-event. Auto-dismisses when a later `llm.request.completed` arrives or the countdown elapses (with a ~3s grace so the eye catches the resolution). Pure derivation of existing `scan_events` — no schema, no extra fetch. Pre-fix, operators were wondering "is it stuck?" while strix slept through 45-second backoffs. | [§13.1](wrapper-wishlist.md#131-resilience--cost-gating-engine-112-113-114); [engine PR #112](https://github.com/ClatTribe/strix/pull/112). | S |
| ⬜ | **Cost-cap configurator** with per-target/per-org budget. `--max-cost` / `--max-input-tokens` propagation; `run.terminated{reason: "budget_exceeded"}` rendering. | [§13.1](wrapper-wishlist.md#131-resilience--cost-gating-engine-112-113-114); [engine PR #113](https://github.com/ClatTribe/strix/pull/113). | M |
| ⬜ | **HAR / Burp upload UI.** Drag-drop `.har` / `.xml`, upload into the engine container, trigger `ingest_har_file` / `ingest_burp_file`. Coverage-uplift summary post-ingest. **Most pen-tests start with a Burp recording** — this is the on-ramp. | [§15.2](wrapper-wishlist.md#152-har--burp-project-ingestion-engine-141); [engine PR #141](https://github.com/ClatTribe/strix/pull/141). | M |

### 19.6 Tier 6 — Big product features (mostly from `overall.md` analysis)

Deferred until Tiers 0–5 are stable. These are "next product cycle", not "wrapper-engine integration".

| | Item | Wishlist ref | Effort |
|---|---|---|---|
| ⬜ | **Pre-scan profile selector.** "External recon" / "Web pentest" / "API audit" / "Compliance scan" / "Deep scan". Maps to scan_mode + tool subsets. | [§9.1](wrapper-wishlist.md#91-configuration-ux) | M |
| ⬜ | **Daily-scan workflow** with `kev_diff_check` (#75) findings surfaced as the daily highlight. | [§9.1](wrapper-wishlist.md#91-configuration-ux) | M |
| ⬜ | **OODA loop visualisation** of `phase.entered` / `phase.completed` events. | [§9.2](wrapper-wishlist.md#92-live-scan-ux-during-the-run) | M |
| ⬜ | **Tool-call ATT&CK chain visualisation** from `actor.mitre_techniques` (engine #66). | [§9.2](wrapper-wishlist.md#92-live-scan-ux-during-the-run) | M |
| ⬜ | **Cross-scan diff** (new / fixed / regressions) — wrapper as vuln-tracking system, not just scan runner. | [§9.3](wrapper-wishlist.md#93-report-ux-post-scan) | M |
| ⬜ | **Fix-verify targeted rescan.** "I fixed CVE-X; rescan only that endpoint." Uses `--seed-url` + `--scope-mode diff`. | [§9.3](wrapper-wishlist.md#93-report-ux-post-scan) | S |
| ⬜ | **Plain-language Q&A on the scan.** RAG over `events.jsonl` + `vulnerabilities.json`. | [§9.4](wrapper-wishlist.md#94-wrapper-side-ai-features-built-on-top-of-engine-output) | L |
| ⬜ | **Customer threat-model overlay.** User pins endpoints as "auth path" / "billing path"; wrapper boosts engine's reachability score. | [§11](wrapper-wishlist.md#11-wrapper-side-complements-to-engine-zero-fp-detectors) | M |
| ⬜ | **Auto-PR / Jira / Linear integrations.** GitHub PR from a finding when engine has a suggested patch (engine §15 auto-remediation). | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | M |
| ⬜ | **SIEM push integration.** Beyond Sigma rule export — push findings as native events to Splunk HEC / Elastic / Sentinel. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | M |
| ⬜ | **Bug-bounty submission template export.** HackerOne / Bugcrowd / Intigriti / YesWeHack-shape per finding. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | M |
| ⬜ | **Multi-user collaboration.** Comment on findings, assign engineer, mark "in review", @-mention. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | L |
| ⬜ | **RBAC / SSO / audit logging.** SAML / OIDC SSO. Audit log for sensitive actions. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | L |
| ⬜ | **Customer-data redaction in shared reports.** PII / hostname / token-shaped redaction on share. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | M |
| ⬜ | **Public attestation page.** Customer-facing "last scan: X; 0 critical; SBOM available" page. Vendor-trust signal in B2B sales. | [§9.6](wrapper-wishlist.md#96-gaps-overallmd-did-not-surface-real-customer-asks) | M |

---

*Catalog source: [`wrapper-wishlist.md`](wrapper-wishlist.md) (engine team's wrapper-facing wishlist) + [`usage.md`](usage.md) (the operating manual). Tiers 0 + 1 + 2 are the **minimum-viable contract**: they close the wrapper-engine integration loop. Everything in Tier 3+ is incremental polish and product expansion.*

---

*Want to tackle one of these? Open a draft PR with a one-paragraph description of your approach. [`Architecture.md`](Architecture.md) is the canonical reference for the isolation model and design choices to preserve.*
