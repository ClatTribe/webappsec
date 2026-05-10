# `AISecurityEngineerUXRoadmap.md` — wrapper implementation proposal for Phase A-H

**Audience:** webappsec contributors. This doc is the wrapper-side
implementation proposal responding to the engine team's
[`strix/AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md)
(the canonical *what should this product surface look like* spec for
vibe-coded SaaS founders).

> **Engine team owns *what*; wrapper team owns *how*.** The engine
> team's UX doc says "Phase A is GitHub App + PR comments." This doc
> says "we'll ship that in webappsec via these specific schema
> migrations, API routes, and components, in this order, with these
> success criteria."

> **Why this is its own doc, not a §20 in `roadmap.md`.** §19 of
> `roadmap.md` is the engine-PR-rendering tier work
> ([`wrapper-wishlist.md`](wrapper-wishlist.md) gap-closure). That's
> *plumbing*. The Phase A-H roadmap is *product*. They're different
> mental models — keeping them in separate docs keeps each focused.

---

## Contents

0. [Why this doc + how to read it](#0-why-this-doc)
1. [Inventory — what's already built](#1-inventory)
2. [Phase A — Onboarding + GitHub App](#2-phase-a)
3. [Phase B — Findings inbox + triage UX](#3-phase-b)
4. [Phase C — Compliance layer](#4-phase-c)
5. [Phase D — Integrations](#5-phase-d)
6. [Phase E — Auto-fix PR workflow](#6-phase-e)
7. [Phase F — Continuous monitoring dashboard](#7-phase-f)
8. [Phase G — Multi-tenant org features](#8-phase-g)
9. [Phase H — Customer trust + audit polish](#9-phase-h)
10. [Engine-artifact ingestion plan (cross-cutting)](#10-engine-artifact-ingestion)
11. [Pricing-tier alignment](#11-pricing-tier-alignment)
12. [Phase ordering + dependencies](#12-phase-ordering)
13. [Open questions for engine team](#13-open-questions-for-engine-team)
14. [Tracking](#14-tracking)

---

## 0. Why this doc

The engine team has shipped through PR #219 with single-lead
asset-aware planning, SCA, SAST/SARIF, finding-chains, compliance
evidence emission, real-time KEV/EPSS/NVD intel, and 13,123 nuclei
templates — 88% recall on the Juice Shop benchmark. The plumbing layer
is broadly in place engine-side.

The wrapper has shipped 22 PRs (#46-#67) optimised for a
security-engineer / pentester mental model — per-target scan-creation
form, compliance pack zip, casefile per finding. **Most of that
plumbing carries over** to the vibe-coded-founder persona, but the
*primary surface* (GitHub App + inline PR comments) is ~10% built.
That's the biggest gap.

This doc proposes how to close that gap, in order, with concrete
schema migrations, API routes, components, and acceptance criteria
per phase.

### Conventions

- **Status emoji** (per row, throughout):
  - ✅ shipped + verified
  - 🚧 partially shipped (specifics in row)
  - ⬜ not started
- **Migration numbering** continues from `040` (current head: `039`).
- **Test coverage expectation:** worker tests pass at every PR (215+
  baseline); 0 net-new TS errors over the existing typegen-drift
  baseline (44 errors at session end).
- **PR sizing** mirrors `roadmap.md` conventions: XS / S / M / L.
- **Each phase ships across multiple PRs** — the per-phase tables
  below break each engine-team item (e.g. "A.5 PR-comment renderer")
  into concrete wrapper deliverables.

---

## 1. Inventory — what's already built

Per [`usage.md` §9.10](usage.md#910-honest-gap-summary), the
phase-percentage estimates are:

```
Phase A  (GitHub App + PR comments)         ~10%   ← BIGGEST GAP
Phase B  (findings triage UX)               ~70%
Phase C  (compliance)                       ~50%
Phase D  (integrations)                     ~15%
Phase E  (auto-fix PRs)                     ~0%    ← engine Phase 12 dep
Phase F  (continuous monitoring)            ~25%
Phase G  (multi-tenant + billing)           ~40%
Phase H  (trust pages)                      ~0%
```

Carry-overs the wrapper can directly reuse for Persona 1 (vibe-coded
founder):

| Wrapper feature | Source PR | Phase row served |
|---|---|---|
| Multi-tenant org + RLS + audit_log | pre-session foundation | G.1, G.2 partial, G.5 |
| FP feedback loop end-to-end | PR #45, #47 | B.3 |
| Casefile per finding (confidence + reasoning_trace + counter_proof + kill_chain + trajectory + force-show) | PR #42, #46, #47, #48, #49 | B.1, B.5 |
| Compliance overlay grouped by 7 frameworks | PR #52 | C.1, C.2 partial |
| Compliance pack ZIP + audit_log on download | PR #50 | C.3 partial |
| SBOM viewer + CycloneDX export | PR #53 | C.3 partial |
| Vendor risk + MFA + monitoring posture + compliance posture cards | PR #51, #52, #54 | C.2 partial, F.4 partial |
| Coverage banner + trust-gap fix | PR #64 | B.5 partial, C trust signal |
| Cost cap + budget-exceeded amber UX | PR #58 | F.6 partial |
| Slack webhook (scan-complete) | PR #62 | D.1 partial |
| CI/CD snippet generator | PR #57 | D.7 partial |
| Cancel → SIGTERM | pre-session | F.1 trust signal |
| HAR/Burp upload | PR #60 | (deprecated for vibe-coded persona; keep for Persona 2) |
| Fix-verify rescan | PR #61 | (transitional until Phase E auto-fix lands) |
| Per-org STRIX_* threat-intel keys | PR #46 | A.4 partial |

Things to **deprecate** or de-emphasize for Persona 1:

- HAR/Burp upload UI — keep for Persona 2 (AppSec engineer); not in
  the founder onboarding flow.
- Per-target scan-creation form — replaced by GitHub App's
  `installation` webhook auto-trigger. Keep the form for manual
  re-scans / Persona 2 workflows; demote it from primary.
- Manual fix-verify button on FindingCard — replaced by Phase E
  auto-fix; keep until Phase E lands.

---

## 2. Phase A

**Engine-team goal (verbatim):** *"a founder signs up, installs the
GitHub App, and sees their first finding inline on a PR within 5
minutes."*

### A.0 Architectural decisions for this phase

1. **GitHub App, not OAuth App.** Finer-grained permissions, per-installation
   pricing, brandable PR comments. (Open question 4 in engine doc — we
   commit here.)
2. **Webhook-driven scan trigger** via existing `pg_notify('scan_queued', ...)`
   pipeline. The GitHub App's webhook handler enqueues a scan; the
   existing worker listener picks it up. Reuses all PR #46-#67
   plumbing.
3. **One repo = one target.** Map GitHub `installation_repositories[]`
   to `targets` rows of `type='repository'`. Production-URL capture
   (A.4) creates an additional `web_application` target.
4. **Production scans use existing target/scan flow.** The GitHub App
   doesn't introduce a parallel scan path — it just creates `scans`
   rows the same way the manual UI does today.

### A.1 Sign-up + auth (foundation)

| Item | Status | Proposed change |
|---|---|---|
| Email magic link | ✅ Supabase auth shipped | none |
| Google OAuth | ✅ supported via Supabase auth provider | confirm enabled in production env |
| GitHub OAuth | 🚧 supported via Supabase but not enabled by default | enable for the install flow (A.2 needs the user already signed in to attribute the install to an org) |
| Multi-tenant org structure (user → org → repo) | ✅ existing `organizations` + `org_members` schema | none |

**No PR needed for A.1** — Supabase auth + existing schema covers it.

### A.2 GitHub App install flow

**Schema (migration 040):**

```sql
-- New table linking a GitHub App installation to one of our orgs.
-- One installation can cover N repos; we materialise each as a target
-- via the installation_repositories webhook.
create table public.github_installations (
  id                bigint primary key,             -- GitHub installation_id (stable across renames)
  org_id            uuid not null references public.organizations(id) on delete cascade,
  account_login     text not null,                  -- GitHub user/org login (display only)
  account_type      text not null check (account_type in ('User','Organization')),
  installed_by      uuid not null references auth.users(id),
  installed_at      timestamptz not null default now(),
  suspended         boolean not null default false,
  permissions       jsonb,                          -- snapshot of granted permissions (audit)
  webhook_secret_id uuid                            -- pointer to vault.secrets (per-install HMAC secret)
);

alter table public.github_installations enable row level security;
create policy github_installations_member_read
  on public.github_installations for select to authenticated
  using (org_id = public.current_org_id());
```

**API routes (new):**

| Route | Purpose |
|---|---|
| `GET /api/github/install` | Redirect to GitHub App install URL with `state=<org_id>` |
| `GET /api/github/install/callback` | GitHub redirects here after install; verify state, store `installations` row, fire first-scan job |
| `POST /api/github/webhook` | Receive `installation`, `installation_repositories`, `pull_request`, `push` events |

**Worker:** new helper `_dispatch_github_event` in a new
`webhook_dispatcher.py`. Verifies HMAC signature against per-install
secret, dispatches to scan-queue.

**Effort:** M (~4-5 days). 1 migration + 3 API routes + new
GitHub-App registration on the github.com side + webhook signature
verification + happy-path test.

**Acceptance criteria:**
- A user lands at `/api/github/install`, redirects to GitHub, installs
  the app, and lands back on the dashboard with the install
  registered.
- `installation_repositories.added` events create `targets` rows of
  type `repository`.
- `pull_request.opened` events fire a scan within 30s.

### A.3 First-scan trigger on `installation` webhook

| Item | Status | Proposed change |
|---|---|---|
| Auto-create `targets` rows from installed repos | ⬜ | webhook handler `installation_repositories.added` → insert `targets` |
| Fire initial scan on default branch | ⬜ | scan-queue insert via existing `create_scan_with_targets` RPC |
| Stream progress to dashboard via WebSocket | ✅ existing Supabase realtime | reuse `scans` realtime channel |
| Render findings within 60s | depends on engine speed; SCA on a small repo should hit | acceptance criteria below |
| Skip DAST on initial scan (no production URL yet) | scan-mode flag; existing | pass `dns_only=false, scope_mode='auto'`, skip web_application target unless A.4 ran |

**Effort:** S (~2 days). Mostly webhook→RPC plumbing.

### A.4 Production URL capture

| Item | Status | Proposed change |
|---|---|---|
| Onboarding step 2: "What's your production URL?" | ⬜ | add `production_url_captured` to onboarding flow |
| Validate URL reachability | 🚧 engine PR #29 preflight handles this; we trigger it | add a probe-step before scan creation |
| Trigger DAST baseline | 🚧 — manual scan creation works | auto-create `web_application` target on URL capture; queue baseline scan |
| Schedule recurring scans (default every 24h) | ⬜ | new `scheduled_scans` table + cron worker (depends on Phase F daemon) |

**Schema (migration 041):**

```sql
alter table public.targets
  add column if not exists production_url text,                 -- the captured URL for repository targets
  add column if not exists last_baseline_scan_id uuid references public.scans(id) on delete set null;
```

**Effort:** S (~2 days) for capture + manual baseline; cron piece
deferred to Phase F.

### A.5 PR-comment renderer

This is **the single highest-impact wrapper feature** for Persona 1.
The engine emits SARIF (engine PR #219, Phase 7.5); the wrapper
forwards it to GitHub Code Scanning for inline rendering. We *also*
post a wrapper-branded summary comment with our prose.

**Architecture:**

```
[ pull_request webhook ]
        │
        ▼
[ wrapper API route /api/github/webhook ]
        │
        ├─▶ enqueue diff-aware scan (engine `--diff-base <merge-base>`)
        │
        ▼
[ worker runs scan; emits SARIF + vulnerabilities.json + finding_chains.json ]
        │
        ▼
[ wrapper post-scan hook ]
        │
        ├─▶ POST SARIF to GitHub Code Scanning API (PR #67 §9.9 row 2)
        │
        ├─▶ Compute "new findings vs. main" delta
        │
        ├─▶ POST inline PR comments per finding (one comment per file/line)
        │
        ├─▶ POST single Check Run with status (success / neutral / failure)
        │
        └─▶ Update PR description footer with scan summary
```

**Worker module (new):** `pr_renderer.py` — does the diff comparison
+ comment formatting + GitHub API calls. Idempotent on re-runs (uses
GitHub's "edit comment" path keyed by a stable comment marker).

**Comment template** (verbatim from engine doc A.5):

```
⚠️ **strix found a security issue** (severity: HIGH, CWE-89)

**SQL injection in `req.query.id`** at `pages/api/users.ts:34`

This finding came from: SAST (Semgrep rule sql-injection-express)

**Recommended fix**: parameterize the query
[Apply Fix] (button — opens auto-fix PR via Phase E)

See full details: <link to dashboard>
```

**Schema (migration 042):**

```sql
-- Track every PR-comment we post so we can edit/delete idempotently.
create table public.github_pr_comments (
  scan_id      uuid not null references public.scans(id) on delete cascade,
  finding_id   uuid not null references public.findings(id) on delete cascade,
  pr_number    int not null,
  installation_id bigint not null references public.github_installations(id) on delete cascade,
  github_comment_id bigint,                           -- null until first post; non-null after
  body_hash    text not null,                         -- so we can detect when we'd post the same body
  posted_at    timestamptz not null default now(),
  primary key (scan_id, finding_id, pr_number)
);
```

**Effort:** L (~7-10 days). The biggest single PR in this phase. Test
plan needs a fixture repo on GitHub with seeded vulnerabilities.

**Acceptance criteria:**
- New finding lands as inline PR comment on the right line within 60s
  of `pull_request` webhook.
- Re-running the scan edits the existing comment (no duplicates).
- Check Run shows `failure` for severity `critical`/`high`,
  `neutral` for medium and below.
- SARIF appears in GitHub Security tab.
- "Apply Fix" button is wired to the Phase E flow even before Phase E
  ships (button is disabled with "auto-fix pending" tooltip until
  engine Phase 12 lands).

### A.6 Dashboard skeleton

✅ Already shipped. The current findings inbox (per-scan list with
filters / sort / bulk actions) maps to the engine team's
A.6 spec. No changes for Phase A; refinements come in Phase B.

### A.7 Onboarding UX flow

| Step | Engine-team spec | Status |
|---|---|---|
| 1 | Sign up (email + magic link) | ✅ |
| 2 | Create org (name + size dropdown) | ✅ — first-org auto-create exists; size dropdown ⬜ |
| 3 | **Install GitHub App** (one click) | ⬜ — A.2 dep |
| 4 | Select repos to scan (default: all) | ⬜ — `installation_repositories` event handler |
| 5 | Capture production URL (optional, can skip) | ⬜ — A.4 dep |
| 6 | First scan runs (60s) — show progress | ✅ realtime channel; needs onboarding-flow integration |
| 7 | Findings dashboard | ✅ |

**Time-to-first-finding target: < 5 min.** This is achievable on a
small repo with SCA only. SAST can take longer; first scan should
run SCA + secrets first and emit findings progressively.

**Effort:** M (~3-4 days) for the onboarding wizard component
(steps 1-7 stitched together) plus the existing dashboard.

**PR sequencing for Phase A:**

| PR | Item | Effort |
|---|---|---|
| #68 | Migration 040 + GitHub App install/callback API routes | S |
| #69 | Migration 041 + production URL capture step | S |
| #70 | Webhook dispatcher + `installation_repositories.added` handler | S |
| #71 | Migration 042 + PR-comment renderer (the big one) | L |
| #72 | SARIF forward to GitHub Code Scanning | S |
| #73 | Onboarding wizard component + step orchestration | M |

**Total Phase A effort:** ~3-4 weeks small team.

---

## 3. Phase B

**Engine-team goal:** *"customers spend < 1 minute per finding to
triage; false-positive rate < 10%."*

### B.1 Severity calibration cards

✅ Mostly shipped (PR #42 / #46). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| Severity (with CVSS-vector tooltip) | ✅ | none |
| Reachability (engine Phase 6.4 result) | ⬜ | parse `[reachability=...]` prefix from finding title (per engine doc 13a.3); render as a chip |
| "Why critical?" prose from `reasoning_trace` | ✅ | none |
| Affected file/endpoint with code snippet | 🚧 — endpoint shown; code snippet ⬜ for repository targets | new component `CodeSnippetSection` reads from engine `decision_log.jsonl` (PR #74) |
| Linked CVE/CWE | ✅ | none |
| Severity adjustable by customer (with reason → telemetry) | ⬜ | new `findings.user_severity` column + adjuster UI; logs to `triage_signals` (PR #75) |

**PR #74 — Reachability + code-snippet rendering** (S, ~3 days)
- Parse `[reachability=...]` prefix from finding titles
- Render reachability chip on FindingCard with tooltip explaining the
  4 values (`direct_import` / `transitive_only` / `unused` / `unknown`)
- Default-collapse `unused` / `transitive_only` findings; toggle to
  show all
- Read engine's `code_map.json` (when present) to render code snippet
  with surrounding lines

**PR #75 — User-severity adjustment** (S, ~2 days)
- Migration 043: `findings.user_severity` (severity enum, nullable)
  + `findings.user_severity_reason` (text)
- Inline adjuster on FindingCard (dropdown + reason-required modal)
- Trigger writes a `triage_signals` row so the engine learns
  per-customer

### B.2 Bulk triage actions

| Item | Status | Proposed change |
|---|---|---|
| "Dismiss all CWE-X in repo Y" | ⬜ | new findings-list multi-select + bulk-action toolbar |
| "These are all from generated code" → contextual dismissal | ⬜ | new `dismiss_reason="generated_code"` enum value |
| "Snooze for 30 days" | ⬜ | new `findings.snoozed_until` column; status filter "Active" excludes snoozed |
| "Assign to teammate" | ⬜ | new `findings.assignee_id` (depends on G.1 team layer); routes to email/Slack DM |

**PR #76 — Bulk triage** (M, ~5 days)
- Frontend multi-select UI on findings list
- Backend bulk-update endpoint (RLS-respecting)
- New triage-action enum values + audit_log entries

### B.3 FP learning loop

✅ Already shipped (PR #45, #47). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| "Recently dismissed" view | ⬜ | new findings list filter + dedicated tab |
| "After 5 dismissals of similar findings, prompt to auto-dismiss" | ⬜ | nightly cron job analyses `triage_signals`; emits in-app banner |
| "We saw 5 similar findings; you dismissed 4. Auto-dismissed." display | 🚧 — banner shipped (PR #47) but doesn't show the count | enrich the auto-dismiss banner with the count from `prior_label_attribution` |

**PR #77 — Recently-dismissed view + count enrichment** (S, ~2 days)

### B.4 Finding lifecycle

✅ Existing status enum (`open → triaged_real → fixed → dismissed →
wont_fix`) covers it. Auto-fix on non-recurrence already implemented
via cross-scan dedup (fingerprint). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| SLA tracking per state | ⬜ | new `findings.sla_breached_at` + nightly cron (depends on C.4 SLA config) |
| Historical view: "open from Jan 15 to Feb 03" | 🚧 — `times_seen` + `last_seen_at` exist; presentation is per-finding chip not timeline | new `FindingTimelineSection` component |

**PR #78 — Finding timeline section** (S, ~2 days)

### B.5 Per-finding evidence trail

✅ Mostly shipped (PR #47 trajectory + PR #48 kill chain + PR #61
verify-fix). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| Decision-log walk for this finding | ⬜ | parse engine `decision_log.jsonl`; render as a collapsible "Engine decisions" sub-section on FindingCard |
| Render the chain (Phase 5.2 chaining graph) | ⬜ | consume `finding_chains.json` (engine PR #219); render as collapsible card grouping N findings under one chain header |
| Auto-generated cURL PoC | 🚧 — engine emits `poc_md`; we render markdown | extract cURL from poc_md as a separate copy-button block |

**PR #79 — `decision_log.jsonl` ingestion + decisions section** (M, ~3 days)
- Migration 044: `findings.decision_log` jsonb (filtered to this finding's lineage)
- Worker: filter decision_log per finding via `finding_id` join key
- Frontend: collapsible section on FindingCard rendering the walk

**PR #80 — `finding_chains.json` chain card** (M, ~4 days)
- Migration 045: `scan_finding_chains` table (chain_id PK + scan_id +
  finding_ids array + chain_type + summary + max_severity + categories)
- Worker: `_persist_finding_chains` reads `finding_chains.json` post-scan
- Frontend: new `FindingChainCard` collapsible component grouping
  constituent findings; sort chains spanning >2 categories first;
  per-chain colour scheme per engine doc 13a.1 (`sca_dast` red, etc.)
- Inbox: when a finding belongs to a chain, render only the chain card,
  not the constituent findings (to avoid double-render)

### B.6 Per-team / per-repo views

| Item | Status | Proposed change |
|---|---|---|
| Filter findings by team membership | ⬜ — depends on G.1 team layer | route through G.1's `teams` table |
| MTTR per severity | ⬜ | aggregate query over `findings.created_at` → `findings.fixed_at` |
| Per-repo trend chart | ⬜ | depends on Phase F charting layer |

**Defer:** Phase B.6 ships *after* G.1 (team layer) lands.

### B.7 Triage keyboard shortcuts

**PR #81 — Keyboard shortcuts** (XS, ~1 day)
- `j` / `k` for next/prev finding
- `d` for dismiss (with reason modal)
- `f` for mark fixed
- `?` for shortcut help
- Use `useHotkeys` hook (or hand-rolled with `useEffect`)

**PR sequencing for Phase B:**

| PR | Item | Effort |
|---|---|---|
| #74 | Reachability chip + code snippet | S |
| #75 | User-severity adjustment | S |
| #76 | Bulk triage actions | M |
| #77 | Recently-dismissed view + count enrichment | S |
| #78 | Finding timeline section | S |
| #79 | `decision_log.jsonl` ingestion | M |
| #80 | `finding_chains.json` chain card | M |
| #81 | Keyboard shortcuts | XS |

**Total Phase B effort:** ~3 weeks small team.

---

## 4. Phase C

**Engine-team goal:** *"replace Vanta/Drata for security-finding
evidence collection."*

### C.1 Control mapping

✅ Per-finding `compliance_controls` JSONB shipped (PR #42). But
**this should now be replaced** by ingesting engine's
`compliance_evidence.json` (engine PR #219 §4b).

**PR #82 — `compliance_evidence.json` ingestion** (M, ~4 days)
- Migration 046: `scans.compliance_evidence` JSONB (the whole engine
  artifact verbatim)
- Worker: `_persist_compliance_evidence` reads the file post-scan
- Frontend: `ComplianceOverlay` (PR #52) reads from the new JSONB
  instead of per-finding derivation; falls back to per-finding for
  older scans
- Schema is the engine team's: per-control verdict
  (`pass`/`fail`/`warn`/`info`/`untested`)

This is the **highest-leverage single PR** in Phase C — it replaces
our derived control mappings with the engine's authoritative typed
output.

### C.2 Compliance dashboard

| Item | Status | Proposed change |
|---|---|---|
| Per-framework view | 🚧 — overlay groups findings by framework (PR #52) | add a top-level "Compliance" page (not just per-scan) — renders org-level `compliance_evidence.json` aggregated across scans |
| Per-control: pass/fail/in-progress with evidence count | ⬜ | depends on PR #82; new component `ControlStatusCard` |
| "12 controls failing" quick-glance | ⬜ | summary tile on the org dashboard |
| Filter by audit period (last 12 months for SOC 2 Type 2) | ⬜ | date-range filter on the new compliance page |
| **`untested` coverage-gap surfacing** ("These controls aren't validated by strix; you need other tooling") | ⬜ | dedicated section on the compliance page |

**PR #83 — Org-level Compliance page** (L, ~6-8 days)
- New page `/compliance` aggregating across the org's scans
- Per-framework cards (SOC 2 / ISO 27001 / PCI DSS / OWASP ASVS)
- Per-control drill-down → list of finding IDs that hit it
- `untested` section as a separate "you need other tooling" callout
- Date-range filter (last 12 months default for SOC 2 Type 2)

### C.3 Evidence pack generator

✅ ZIP shipped (PR #50). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| PDF export | ⬜ | use `puppeteer` server-side or `react-pdf`; auditor-facing format |
| DOCX export | ⬜ | use `docx` library; lower priority than PDF |
| Continuous monitoring proof (Phase F.3 daemon logs) | ⬜ | depends on Phase F |
| IaC posture from engine Phase 11 | ⬜ | consume `iac_posture.json` (engine PR #219) |

**PR #84 — PDF evidence pack** (M, ~4 days)
- Server-side PDF rendering of the existing compliance pack contents
- Same audit_log entry as the ZIP (`scan.compliance_pack.download` →
  add `format=pdf` field)
- Auditor-friendly layout: cover page + per-control evidence section +
  scan log + signature page

### C.4 Remediation SLAs

**PR #85 — Per-severity SLA tracking** (M, ~5 days)
- Migration 047: `organizations.sla_critical_days` (default 7),
  `sla_high_days` (default 30), `sla_medium_days` (default 90)
- Frontend: SLA settings page in org settings
- Background job: nightly cron flips `findings.sla_breached_at`
  when `created_at + sla_days < now() AND status NOT IN ('fixed',
  'dismissed')`
- Slack alerts at 75% / 100% breach (depends on D.1 webhook delivery)
- SLA dashboard tile on the org dashboard

### C.5 Risk register integration

| Item | Status | Proposed change |
|---|---|---|
| Each finding can be linked to a risk-register entry | ⬜ | new `risk_register` table + linking on FindingCard |
| Custom fields: business impact, likelihood, control owner | ⬜ | jsonb metadata + form |
| Export to common audit-tooling formats (Drata-style import) | ⬜ | CSV export with Drata column mapping |

**PR #86 — Risk register MVP** (M, ~4 days)

### C.6 Continuous compliance daemon

⬜ Defer to Phase F. Rationale: depends on engine Phase 13 continuous
scanning + wrapper Phase F.3 drift detection. Not standalone.

### C.7 Customer-facing trust page

⬜ Move to Phase H (where the engine-team doc puts it for full
implementation). C.7 is just the "MVP version" — a single static page
per org showing compliance status. Phase H adds custom domains,
branding, and questionnaire automation.

**PR #87 — MVP trust page** (M, ~4 days)
- New public route `/<org-slug>/security` (no auth)
- Renders compliance posture + recent improvements + SLA performance
- Org admins can toggle public visibility
- Phase H replaces this with a richer customisable version

### C.8 Auditor portal

**PR #88 — Read-only auditor access** (S, ~3 days)
- New `auditors` table: `auditor_id, org_id, expires_at, share_token`
- Public route `/auditor/<share_token>` with read-only org view
- Audit log of every auditor access (who looked at what)
- Auto-expires per `expires_at`

**PR sequencing for Phase C:**

| PR | Item | Effort |
|---|---|---|
| #82 | `compliance_evidence.json` ingestion | M |
| #83 | Org-level Compliance page | L |
| #84 | PDF evidence pack | M |
| #85 | Per-severity SLA tracking | M |
| #86 | Risk register MVP | M |
| #87 | MVP trust page | M |
| #88 | Auditor portal | S |

**Total Phase C effort:** ~4-5 weeks small team.

---

## 5. Phase D

**Engine-team goal:** *"meet customers where they are. Slack, Linear,
Jira, GitHub annotations."*

### D.1 Slack integration

🚧 Webhook-based scan-complete shipped (PR #62). Remaining:

| Item | Status | Proposed change |
|---|---|---|
| OAuth install flow | ⬜ | Slack App registration; replaces manual webhook URL paste |
| Slash commands (`/strix scan <repo>`, `/strix findings <repo>`, `/strix dismiss <id>`) | ⬜ | new API routes responding to Slack events |
| Real-time alerts (new critical finding, SLA breach, scan complete digest) | 🚧 — scan complete (PR #62); critical-finding live alerts ⬜ | extend `notifier.py` to dispatch on `finding.created` events |

**PR #89 — Slack OAuth + slash commands** (L, ~7 days)

### D.2 Linear integration

**PR #90 — Linear integration** (M, ~5 days)
- OAuth install flow
- Auto-create Linear issues for findings ≥ severity threshold
  (configurable per org)
- Two-way sync: Linear status → finding state via Linear webhooks
- Per-team / per-project mapping by finding-category

### D.3 Jira integration

**PR #91 — Jira integration** (M, ~5 days). Same pattern as Linear,
slightly more config (per-project mappings, field mappings, custom
workflows).

### D.4 GitHub Code Scanning integration

✅ Shipped via Phase A (PR #72) — SARIF forward.

### D.5 Generic outbound webhook

**PR #92 — Generic webhook** (S, ~3 days)
- New `webhooks` table: target URL + HMAC secret + filter (event
  types) + customer-defined targets
- Worker dispatcher fans out finding-lifecycle events
- Retry policy + DLQ

### D.6 CLI / API

🚧 Wrapper has internal API; no public REST API yet.

**PR #93 — Public REST API + per-org keys** (M, ~5 days)
- OpenAPI spec
- Bearer-token auth via per-org API keys (existing schema has
  `api_tokens` table)
- Rate limit per token
- CLI tool `strix-cli` is just an HTTP client over this API

### D.7 CI integration packs

🚧 CI snippet generator shipped (PR #57) for static YAML. Remaining:

| Item | Status | Proposed change |
|---|---|---|
| GitHub Actions: `uses: strix/scan-action@v1` | ⬜ | publish a real composite action to GitHub Marketplace |
| GitLab CI template | ⬜ | publish to GitLab CI catalog |
| CircleCI orb | ⬜ | publish |
| Jenkins plugin | ⬜ | low priority; defer |
| Pre-commit hook | ⬜ | wraps `strix-cli` |

**PR #94 — GitHub Actions composite action** (S, ~3 days). Highest
priority of D.7 because it integrates with GitHub Code Scanning.

**PR sequencing for Phase D:**

| PR | Item | Effort |
|---|---|---|
| #89 | Slack OAuth + slash commands | L |
| #90 | Linear integration | M |
| #91 | Jira integration | M |
| #92 | Generic outbound webhook | S |
| #93 | Public REST API | M |
| #94 | GitHub Actions composite action | S |

**Total Phase D effort:** ~3-4 weeks small team.

---

## 6. Phase E

**Engine-team goal:** *"customers click 'Apply Fix' on a PR comment
and get a fix PR opened automatically."*

### Critical dependency

Phase E depends on **engine Phase 12** (auto-fix codemod library +
`auto_fix_patches.json` artifact). Engine roadmap shows Phase 12 is
**not yet started**. Wrapper-side Phase E ships within ~2 weeks of
engine Phase 12 landing.

**Pre-engine-Phase-12 work the wrapper can do** (PR #95, S, ~2 days):
- Wire the "Apply Fix" button on PR comments + FindingCard with a
  disabled state + tooltip ("auto-fix pending — engine Phase 12")
- Schema (migration 048): `findings.auto_fix_patch` jsonb,
  `findings.auto_fix_pr_url` text, `findings.auto_fix_status` enum
  (`pending` / `applied` / `merged` / `rejected` / `regression`)

**Post-engine-Phase-12 work** (PR #96, L, ~7 days):
- Worker reads `auto_fix_patches.json`; populates `auto_fix_patch`
- "Apply Fix" button enabled; click opens GitHub PR via the GitHub
  App
- Per-fix confidence gating
- Bulk fix workflow (apply N similar fixes in one PR)
- Fix preview (Monaco diff view)
- Auto-fix telemetry per customer
- Safety controls (per-org config: auto-open vs. manual; per-severity
  gates; rollback on regression)

**Total Phase E effort:** S now + L when engine ships.

---

## 7. Phase F

**Engine-team goal:** *"customers see their security posture trend in
real-time, alerted on regressions."*

### F.1 Real-time scan status

✅ Shipped (Supabase realtime channels on `scan_events` + `scans`).

### F.2 Trend charts

| Chart | Status | Proposed change |
|---|---|---|
| Open findings over time | ⬜ | new chart on org dashboard; query from `findings` |
| Time-to-fix per severity | ⬜ | aggregate over `findings.created_at → fixed_at` |
| Fix-rate per repo | ⬜ | per-target aggregation |
| Coverage per OWASP / CWE category | ⬜ | aggregate from `findings.compliance_controls` |
| Industry-benchmark comparison | ⬜ | depends on engine Phase 13.2 cross-customer data |

**PR #97 — Trend charts** (M, ~5 days)
- Use a charting library (Recharts or Tremor)
- Backend SQL aggregates via new `org_trend_metrics` materialized view
  (refreshed nightly)

### F.3 Drift detection

⬜ Depends on engine Phase 13.4 `continuous_scan_deltas.jsonl`.

**PR #98 — Drift alerting daemon** (M, ~5 days, post-engine-13.4)
- Cron-driven: every 1 hour, scan the latest run's
  `continuous_scan_deltas` for new endpoints / regressed findings
- Alert routing via Phase D integrations (Slack / email / webhook)
- "Production drift detected — new endpoint `/api/admin` is missing
  auth" copy

### F.4 Compliance posture trend

| Item | Status | Proposed change |
|---|---|---|
| "Your SOC 2 readiness: 87% (up from 82%)" | ⬜ | aggregate from `compliance_evidence.json` per scan; trend line |
| Per-control trend lines | ⬜ | drill-down view |

**PR #99 — Compliance posture trend** (S, ~3 days)

### F.5 Asset inventory

| Item | Status | Proposed change |
|---|---|---|
| Discovered assets (endpoints, dependencies, infra) | ⬜ | new `asset_inventory` table; populated from `surface_map.json` (engine artifact) + `sca_inventory.json` |
| Risk score per asset | ⬜ | derived from finding count + severity per asset |
| Filter / search / export | ⬜ | new asset-inventory page |

**PR #100 — Asset inventory page** (M, ~5 days)

### F.6 Cost / usage metrics

🚧 Per-scan cost displayed; aggregated monthly view ⬜.

**PR #101 — Usage tile + monthly aggregation** (S, ~2 days)
- Org dashboard tile: "12 of 50 scans this month, $4.20 / $20 LLM
  budget"
- Per-finding cost attribution (depends on engine
  `llm_fallback_costs.jsonl` Phase 10)

**PR sequencing for Phase F:**

| PR | Item | Effort |
|---|---|---|
| #97 | Trend charts | M |
| #99 | Compliance posture trend | S |
| #100 | Asset inventory | M |
| #101 | Usage tile | S |
| #98 | Drift alerting daemon (post-engine-13.4) | M |

**Total Phase F effort:** ~3 weeks small team (excluding the
post-engine-Phase-13 drift work).

---

## 8. Phase G

**Engine-team goal:** *"scale to 50+ person companies (Persona 2/3
customers)."*

### G.1 Org structure (user → team → repo)

🚧 user → org → target works; team layer missing.

**PR #102 — Teams + per-team repo membership** (M, ~5 days)
- Migration 049: new `teams` table + `team_members` + extend
  `targets` with `team_id` (nullable for org-level targets)
- Frontend: team-management page in org settings
- Filter findings / scans by team

### G.2 RBAC

🚧 owner / admin / member shipped; auditor read-only role ⬜.

**PR #103 — Auditor role** (S, ~2 days)
- Migration 050: extend `org_members.role` enum to include
  `auditor`
- RLS policies grant read-only access to all visible-to-org rows; deny
  all writes
- Frontend: hide write actions for auditor role

### G.3 SSO / SAML / SCIM

⬜ Major work. WorkOS or Auth0 integration recommended.

**PR #104 — WorkOS SSO integration** (L, ~7 days)
- WorkOS account + per-tenant connections
- SAML config UI for enterprise tier
- SCIM provisioning for user lifecycle
- MFA enforcement at org level

### G.4 Stripe billing

⬜ Schema fields exist; billing flow ⬜.

**PR #105 — Stripe billing infrastructure** (L, ~10 days)
- Stripe customer / subscription per org
- Tier-gated feature flags
- Self-service upgrade / downgrade UI
- Usage-based add-ons (LLM-fallback cost passthrough on Pro+ tiers)
- Webhook handler for `customer.subscription.*` events
- Billing audit-log entries
- Past-due grace period (per `roadmap.md` §3 Pillar 1)

This is one of the largest single PRs in the roadmap. Worth doing
properly because billing bugs are the most expensive class.

### G.5 Audit log

✅ Shipped — every sensitive action writes to `audit_log`.

### G.6 Data residency

⬜ Per-region engine instances + per-region storage. Defer until
enterprise demand. Documented as known limitation.

### G.7 Per-team customization

⬜ Depends on G.1.

**PR #106 — Per-team customization** (S, ~3 days, post-G.1)
- Team-level severity thresholds
- Team-level integration configs

**PR sequencing for Phase G:**

| PR | Item | Effort |
|---|---|---|
| #102 | Teams + per-team repo membership | M |
| #103 | Auditor role | S |
| #104 | WorkOS SSO | L |
| #105 | Stripe billing | L |
| #106 | Per-team customization | S |

**Total Phase G effort:** ~5-6 weeks small team.

---

## 9. Phase H

**Engine-team goal:** *"become the security-credential-display layer
customers use to **sell** to their customers."*

Sales-tool angle. Drata's killer feature. Buyers use it to win
enterprise deals (their customers see compliance proof on a shared
URL).

### H.1 Trust page customization

**PR #107 — Custom domain trust pages** (L, ~7 days)
- Migration 051: `organizations.trust_page_domain`,
  `trust_page_branding_jsonb`
- DNS verification flow (CNAME or TXT record)
- Custom CSS upload (Enterprise tier only)
- Configurable sections (which findings/certs to expose publicly)
- Pre-built templates by industry (SaaS / fintech / healthtech)

### H.2 Public sub-page modules

**PR #108 — Trust-page modules** (M, ~5 days)
- "Security at <Customer>" page with frameworks, recent improvements,
  subprocessor list, security-questionnaire contact form
- Public sub-routes: `/<org-slug>/security/<module>`

### H.3 Customer-questionnaire automation

**PR #109 — Questionnaire pre-fill** (L, ~7 days)
- Common questionnaires: SIG, CAIQ, SOC 2 questionnaire
- Pre-fill from existing evidence (`compliance_evidence.json`)
- Track questionnaire response history
- Export as CSV / DOCX for submission

### H.4 Insurance / cyber-policy export

**PR #110 — Insurance underwriter export** (S, ~3 days)
- Pre-formatted report for cyber-insurance underwriters
- Maps wrapper findings + compliance posture to insurer-relevant
  fields
- PDF export

### H.5 Auditor-handover automation

**PR #111 — "Prepare for SOC 2" wizard** (L, ~7 days)
- Multi-step wizard guiding the org through SOC 2 readiness
- Auto-generated readiness assessment
- Gap analysis with remediation suggestions
- Integrates with C.8 auditor portal

### H.6 Compliance-benchmark feed

⬜ Depends on engine Phase 13.2 (cross-customer anonymized data).
Privacy review gates this.

**PR #112 — Benchmark feed** (M, ~5 days, post-engine-13.2)
- "Your security posture is in the top 25% of SaaS companies your
  size" tile on org dashboard
- Privacy-preserving — no per-customer data exposed

**PR sequencing for Phase H:**

| PR | Item | Effort |
|---|---|---|
| #107 | Custom domain trust pages | L |
| #108 | Trust-page modules | M |
| #109 | Questionnaire pre-fill | L |
| #110 | Insurance underwriter export | S |
| #111 | "Prepare for SOC 2" wizard | L |
| #112 | Benchmark feed (post-engine-13.2) | M |

**Total Phase H effort:** ~5-6 weeks small team.

---

## 10. Engine-artifact ingestion

Cross-cutting work. Every new engine artifact requires a small
wrapper-side PR pattern: migration → worker reader → frontend
consumer. The engine team's PR #219 shipped 5 artifacts; subsequent
engine PRs will add more.

### Pattern (every new artifact follows this template)

1. **Migration** (`040+`) — add a JSONB column on the right table
   (typically `scans` for run-level artifacts, `findings` for
   per-finding ones).
2. **Worker** — `_persist_<artifact>` reads the file from `<run_dir>/`
   post-scan; ships via SECURITY-DEFINER RPC.
3. **Worker tests** — happy path + missing file + parse error +
   non-object top-level (mirrors PR #51, #64 patterns).
4. **TypeScript types** — type the JSONB shape; `[k:string]:unknown`
   escape hatch for forward-compat.
5. **Frontend consumer** — typically a new component or a section on
   an existing component.

### The 5 PR #219 artifacts

| Artifact | PR | Phase row | Effort |
|---|---|---|---|
| `compliance_evidence.json` | #82 | C.1 (replaces per-finding derivation) | M |
| `finding_chains.json` | #80 | B.5 (chain card) | M |
| `event_stream.jsonl` | #113 | F.3 (KEV banner) | S |
| `behavioural_baselines.jsonl` | #114 | B.5 (endpoint reference panel) | S |
| SARIF (`*.sarif`) | #72 | A.5 (GitHub Code Scanning) | S |

### The 4 still-pending engine artifacts

| Artifact | Engine phase | Phase row | Wrapper status |
|---|---|---|---|
| `ai_feature_findings.json` | engine Phase 8 | B.1 (AI-feature category in inbox) | wait for engine |
| `iac_posture.json` | engine Phase 11.4 | F.5 (IaC tab) | wait for engine — file-based IaC findings ride in `vulnerabilities.json` today |
| `auto_fix_patches.json` | engine Phase 12 | E.1 (Apply Fix button) | wait for engine |
| `continuous_scan_deltas.jsonl` | engine Phase 13.4 | F.3 (drift alerts) | wait for engine |
| `llm_fallback_costs.jsonl` | engine Phase 10 | F.6 (per-finding cost attribution) | wait for engine |

---

## 11. Pricing-tier alignment

Per engine doc §14, mapping wrapper phases to pricing tiers:

| Tier | Phases enabled | Key features |
|---|---|---|
| **Free** | A, B (limited) | 1 repo, 1 user, weekly scans, no compliance |
| **Pro** | A, B, D, E, F | 5 repos, 5 users, daily scans, integrations, auto-fix, dashboards |
| **Team** | + C | + compliance dashboards, evidence packs, SLA tracking, basic trust page |
| **Enterprise** | + G, H | SSO/SAML, RBAC, audit log, data residency, custom trust page, dedicated support |

Engine costs (LLM-fallback, threat-intel polling) flow through as
usage-based add-ons on Pro+ tiers.

**Implication for sequencing:** Phase G (billing) is a *gate* for
revenue but a *late phase* by customer-value. Ship A → B → C → D + E
in parallel → F → G → H. Customers can be on a free Pro trial during
A through F; G adds the billing layer that converts trial → paid.

---

## 12. Phase ordering

Per engine doc §15, but adapted for our existing PR #46-#67 carryovers:

| Sequence | Phase | Wrapper effort | Engine dep | Customer-value priority |
|---|---|---|---|---|
| 1 | **A — GitHub App + PR comments** | 3-4 weeks | engine 6, 7 ✅ | **highest** |
| 2 | **C.1+C.2 — Compliance evidence ingest + dashboard** | 1-2 weeks | engine §4b ✅ | high (carries over from existing PR #50, #52) |
| 3 | **B — Findings inbox refinements** | 3 weeks | — | high |
| 4 | **D.1+D.4+D.7 — Slack slash + GitHub Actions** | 2 weeks | — | high |
| 5 | **F.1+F.2+F.4+F.6 — Real-time + trend charts** | 2 weeks | — | medium |
| 6 | **C.3-C.8 — Compliance polish (PDF, SLA, auditor portal)** | 3-4 weeks | engine PR #219 ✅ | high (revenue gate) |
| 7 | **G.1+G.2+G.3 — Teams + auditor role + SSO** | 3-4 weeks | — | medium (enterprise gate) |
| 8 | **G.4 — Stripe billing** | 2 weeks | — | high (revenue conversion) |
| 9 | **D.2+D.3+D.5 — Linear + Jira + generic webhook** | 2 weeks | — | medium |
| 10 | **E — Auto-fix PR workflow** | 2 weeks | engine 12 ⬜ | high (post-engine) |
| 11 | **F.3+F.5 — Drift detection + asset inventory** | 2 weeks | engine 13 ⬜ | medium (post-engine) |
| 12 | **H — Customer trust + audit polish** | 5-6 weeks | engine 13.2 ⬜ | medium (sales tool) |

**Wrapper total scope:** ~30-35 weeks of small-team work, gated by
engine-team Phase 12 + 13 timing for the back half.

---

## 13. Open questions for engine team

These complement engine doc §17 with wrapper-specific asks:

1. **`compliance_evidence.json` schema stability.** Engine §4b is
   shipped at `schema_version=1`. Wrapper ingestion (PR #82) pins to
   that version. What's the migration story for schema 2? Field
   addition is fine via `[k:string]:unknown`; rename / removal needs
   a wrapper PR.
2. **`finding_chains.json` chain-id stability.** Are `chain_id` values
   stable across runs (same set of constituent finding fingerprints
   → same `chain_id`)? Wrapper-side chain dedup depends on this.
3. **GitHub Code Scanning SARIF upload pattern.** Should the wrapper
   forward SARIF directly via the GitHub API, or does the engine want
   to expose a tool that does this? Same question for the Phase E
   auto-fix PR.
4. **Cross-customer pattern sharing UX.** Engine team's open question
   #7. From a wrapper UX standpoint: opt-in checkbox on org settings?
   Tier-gated (only Pro+)? Privacy-preserving differential privacy?
5. **Engine HTTP API.** Engine doc §13 says wrapper integrates via
   per-run-dir artifacts, but mentions a future `POST /scans` /
   `GET /scans/<id>/artifacts/<name>` HTTP API. When does that ship?
   The wrapper currently spawns `strix` as a subprocess — moving to
   HTTP unlocks remote-engine deployment and per-tenant engine
   instances.
6. **Engine version pinning.** What's the supported range? Wrapper
   tested against fork commit `3b48809` (PR #144); engine main is at
   PR #219. Should the wrapper pin a specific tag, or always run main?
   For Phase A's GitHub App, pinning a tag matters for SLA.

---

## 14. Tracking

- **This doc is the strategic plan.** Tactical sequence belongs in
  the webappsec issue tracker — but issues are currently disabled on
  this repo, so each phase opens a tracking PR (the same pattern as
  the upstream strix incident PRs at #146, #147, #148).
- **Wrapper releases align with engine artifact availability** —
  wrapper PRs gate on engine artifacts being shipped + schema-stable.
- **Quarterly review** to re-prioritize based on customer feedback +
  engine-team velocity. The phase ordering above is a *plan*, not a
  *commitment*.
- **Breaking changes to engine artifacts** trigger wrapper schema
  migrations. The pattern in §10 covers it.

### Documentation cross-references

| Doc | What's there |
|---|---|
| [`README.md`](README.md) | Local development quickstart |
| [`Architecture.md`](Architecture.md) | Tenant-isolation model + design choices to preserve |
| [`engine-usage.md`](engine-usage.md) | Engine team's wrapper-integration guide (synced from strix) |
| [`wrapper-wishlist.md`](wrapper-wishlist.md) | Per-PR rendering specs from the engine team (older spec; supplanted by `AISecurityEngineerUX.md` for product features) |
| [`roadmap.md`](roadmap.md) §19 | Engine-PR-rendering tier work (the *plumbing* layer underneath this *product* roadmap) |
| [`tools-wishlist.md`](tools-wishlist.md) | Engine PRs the wrapper would like (upstream asks) |
| [`usage.md`](usage.md) | Wrapper-product summary (target types × checks × why-better tables) — §9 has the Phase A-H gap inventory that triggered this doc |
| [`CLAUDE.md`](CLAUDE.md) | Agent guide: doctrine + operational habits |
| [strix `AISecurityEngineer.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineer.md) | **Engine roadmap** — the source of truth for what specialists / scanners / intel sources the engine ships |
| [strix `AISecurityEngineerUX.md`](https://github.com/ClatTribe/strix/blob/main/AISecurityEngineerUX.md) | **Wrapper UX roadmap** — the source of truth this doc proposes implementation for |

Last updated: 2026-05-06 (initial draft after engine team's UX
roadmap publication; revisions tracked via wrapper PRs).
