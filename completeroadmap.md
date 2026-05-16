# TensorShield — Complete roadmap

A gap analysis of strix + webappsec against the "security & compliance
engineer for developers" thesis, evaluated across:

- **Target completeness** — `web_application`, `api`, `repository`,
  `container_image` (the four primary targets)
- **Breadth** — covers each target comprehensively for all
  vulnerability categories that apply
- **Depth** — evaluates each category thoroughly (multiple payloads,
  adaptive retries, cross-correlation)
- **Tools** — signatures / templates / CVE feeds kept current
- **Agent leverage** — uses agent architecture (memory, multi-step
  reasoning, cross-scan correlation) better than incumbents
- **Compliance** — framework breadth + per-control depth

Wrapper-first. Engine-side gaps flagged for context.

---

## 1. Target coverage

### 1.1 `repository` — best covered

| Layer | Status | Missing |
|---|---|---|
| **SAST** | ✅ Semgrep + custom rules; diff-aware via `--scope-mode diff`; Patcher proposes diffs | Per-org custom Semgrep rule library uploadable from settings |
| **Secrets** | ✅ Gitleaks + TruffleHog | Git-history scan (not just current tree); rotated vs active distinction |
| **SCA** | ✅ SBOM CycloneDX, NVD/KEV via threat_intel | EPSS exploitability prioritization in UI; VEX statement ingestion; license compliance surface |
| **CI/IaC** | ⚠️ Trivy IaC scan (engine has it; wrapper doesn't surface as distinct category) | `.github/workflows` audit (CI/CD pipeline security); dependency-confusion / typosquat detection |
| **Supply chain** | ❌ | SLSA provenance verification; signed-commit / signed-release detection; dependabot-alerts ingestion (de-duplicate work) |

### 1.2 `api` — capability exists, exposure incomplete

| Layer | Status | Missing |
|---|---|---|
| **OWASP API Top 10** | ✅ BOLA / BFLA / mass-assignment / rate-limit / GraphQL deep / gRPC reflection (engine PRs #267–#269) | API4: payload-size / depth / fork-bomb probes; API8: CORS / headers / error-verbosity surface; **API9: improper inventory** — shadow / deprecated endpoints (not covered) |
| **Legacy formats** | ❌ | SOAP, JSON-RPC, XML-RPC probes |
| **Auth flows** | ✅ bearer / cookie / basic / login_creds (Phase A) | OAuth flow probing (PKCE, implicit, redirect_uri abuse); JWT alg=none / weak-signature; session-fixation-across-login |
| **Webhook receivers** | ❌ | Signature verification, replay protection, idempotency |

### 1.3 `web_application` — coverage broad, depth uneven

| Layer | Status | Missing |
|---|---|---|
| **OWASP Top 10** | ✅ scan_sqli / scan_xss / scan_idor / scan_csrf / scan_ssrf / scan_xxe / scan_ssti / scan_open_redirect / scan_business_logic | Server-side cache poisoning; HTTP request smuggling (CL.TE, TE.CL); web cache deception; postMessage / window.opener abuse |
| **JS-heavy SPAs** | ⚠️ DOM XSS static probe, browser_action | Prototype pollution (client + server); service worker abuse; WebSocket security (CSWSH) — engine has the tool, never enforced |
| **Auth** | Same set as api | MFA enrollment bypass; password reset token entropy; OAuth state CSRF |
| **Embedded GraphQL** | ❌ api-only | A SPA that embeds GraphQL doesn't get the api specialists |

### 1.4 `container_image` — **target shipping in this iteration**

Engine PR #274 lands the target type upstream. Wrapper-side work is the
focus of the current sprint.

| Layer | Engine (PR #274) | Wrapper today |
|---|---|---|
| Vulnerability scan via Trivy | ✅ `scan_container_image` | ❌ no target type |
| SBOM gen via Trivy / Syft | ✅ embedded | ❌ |
| CVE prioritization (KEV / EPSS) | ✅ shared with SCA | ❌ |
| KG `Dependency` node emission | ✅ shared shape with `scan_sca_lockfiles` | wrapper KG ingest already handles it (migration 058) |
| MOAK feed-trigger consumes image-resident deps | ✅ — new CVEs against image packages fire exploit synthesis | wrapper auto-inherits |

**Layers still missing engine-side (future PRs):**

- Layer-by-layer inspection (`USER root`, secrets in layers, oversized images)
- Container signing / provenance (`cosign verify`, in-toto attestations)
- Base-image hygiene scorecard ("47 unpatched CVEs older than 60 days")

---

## 2. Tool freshness — signatures, CVE feeds, templates

| Tool | Engine state | Wrapper visibility |
|---|---|---|
| **Nuclei** | Auto `nuclei -update-templates` at sandbox build | ❌ no version / template-count surfaced |
| **Semgrep** | Rule packs versioned in binary | ❌ no version surfaced |
| **Trivy** | DB auto-refreshes on each scan | ❌ no DB-freshness surfaced |
| **NVD / KEV / GHSA / EPSS** | `STRIX_THREAT_INTEL_CACHE` SQLite, refreshed on a separate cron | ❌ wrapper doesn't even wire `STRIX_THREAT_INTEL_CACHE` |
| **TruffleHog / Gitleaks** | Latest at sandbox build | ❌ |

**Concrete miss**: scan-detail page should render a "Tools used" panel:
each invoked tool + version + signature/template freshness ("Nuclei
templates: 14,217 · refreshed 3h ago"). Auditor + skeptical-engineer
trust signal.

---

## 3. Agent architecture leverage

The engine is a learning agent. The wrapper treats it like a scanner.

| Engine capability | Wrapper today | Gap |
|---|---|---|
| Per-finding `trajectory.jsonl` reasoning trace (PR #142) | Stored in `findings.trajectory` JSONB, never rendered | "How did the engine arrive at this?" panel on finding cards |
| OPPLAN objective state machine (PR #239) | Phase progress bar shows phase only | Per-objective view: "objective: confirm IDOR on /api/users · status: confirmed via 3 cross-session probes" |
| Researcher sub-agent swarm (PR #259) | Captured as opaque events | No "which specialist found this" attribution on findings; no per-agent cost breakdown |
| MOAK exploit synthesis + Exploit KG nodes (PR #258) | KG panel renders Exploit nodes generically | Dedicated "Working exploits" tab with captured-flag evidence |
| Cross-scan finding fingerprint (PR #137) | Stored on findings, used for dedup | **No "this fingerprint hit 12 of your repos" rollup** — data exists |
| Per-org KNN dismissal model + feedback.jsonl loop (PR #142) | Worker forwards feedback | No "your AI got smarter this week" metric; no model-confidence surface |
| `STRIX_FP_AUTO_DISMISS` policy | Settings expose it | No per-org "AI sharpening" dashboard with FP rate over time |

---

## 4. Compliance — breadth + depth

### 4.1 Framework breadth

| Framework | Trust page | Questionnaire template | Engine evidence |
|---|---|---|---|
| SOC 2 Type II | ✅ | ⚠️ 14 of ~100 Trust Services Criteria seeded | ✅ |
| ISO 27001 | ✅ | ❌ Annex A has 93 controls (2022 edition) | ✅ |
| PCI DSS 4.0 | ✅ | ❌ 12 reqs, ~300 sub-controls | ✅ |
| HIPAA Security Rule | ✅ | ✅ 10 questions (Phase C) | ✅ |
| NIST 800-53 | renders if engine emits | ❌ no template | ⚠️ partial |
| NIST 800-171 / CMMC | none | ❌ | ❌ |
| FedRAMP Moderate / High | renders | ❌ | ⚠️ |
| GDPR Art. 32 | none | ❌ | ❌ |
| CIS Controls v8 | none | ❌ | ❌ |
| CSA STAR / CAIQ | template exists | ✅ | ⚠️ |
| OWASP ASVS | none | ❌ | ⚠️ |

### 4.2 Per-control depth

| Field | Have | Missing |
|---|---|---|
| Verdict (pass/fail/warn/info/untested) | ✅ | |
| Evidence summary text | ✅ | |
| Detail JSONB | ✅ | |
| Observed at | ✅ | |
| Freshness (engine `evidence_collected_at` + `expires_at`) | ✅ (Phase C) | |
| **Evidence trajectory across time** | ❌ | "This control's verdict last 12 quarters" |
| **System component scoping** | ❌ | "CC6.1 PASS for auth-svc, FAIL for billing-svc" |
| **Compensating controls** | ❌ | "CC7.2 FAIL — compensated by Datadog Security Monitoring (artifact attached)" |
| **Cross-framework mapping** | engine has it (PR #254) | Click SOC 2 CC6.1 failure → see ISO 27001 / HIPAA controls that fail in tandem |
| **Per-control owner / DRI** | ❌ | Required for real audit workflow |
| **Audit-window attestation** | ❌ | "Continuous from 2026-Q2 through 2026-Q4" as signed assertion |
| **Per-control discussion thread** | ❌ | Compliance teams need to debate evidence |

### 4.3 Compliance UX gaps

- **Audit readiness score** — we have data, no "87% SOC 2 ready" rollup
- **Quarterly snapshot freeze** — auditors want "as of 2026-Q3-30, my posture was X"
- **Auditor invite flow** — share-link is view-only; no commenting / requesting-more-evidence
- **Vendor risk mode** — engine has `--vendor-mode`, wrapper never exposes

---

## 5. Workflow integration — developer surface

Already shipped: GitHub OAuth, integrations registry, Slack notify,
SARIF → Code Scanning, Patcher → PR, scheduled scans, GitHub repo
importer.

| Surface | Status |
|---|---|
| GitHub Action plugin (scan on PR) | ❌ docs only |
| GitLab CI template | ❌ |
| Bitbucket Pipeline | ❌ |
| JIRA ticket creation | ❌ |
| Linear ticket creation | ❌ |
| PR comment bot | ❌ |
| VS Code extension | ❌ |
| **Cursor / Claude Code MCP server** | ❌ — biggest brand-aligned miss |
| In-app toast notifications | ❌ |
| Email digest (weekly summary) | ❌ |
| Outbound webhooks | ❌ |

---

## 6. Team / collaboration

| Capability | Status |
|---|---|
| Per-finding assignee | ❌ |
| Per-finding comment thread | ❌ |
| @mentions | ❌ |
| Severity-based SLA (auto due-date) | ❌ |
| Triage audit timeline UI | ⚠️ data exists; no view |
| Team digest (weekly Slack) | ❌ |
| Specialized roles (compliance officer / auditor / dev) | ❌ |
| Approval workflow for risk acceptance | ⚠️ Phase B added reason + expiry; no approver |

---

## 7. Onboarding + retention

| Surface | Status |
|---|---|
| First-scan wizard | ❌ |
| "Biggest risk in 60 seconds" first-scan experience | ❌ |
| Vibe-coder stack detection (Cursor / v0 / Lovable / Bolt) | ❌ |
| "Scan my deployed app from this repo" auto-pairing | ❌ |
| Empty-state CTAs on every page | ⚠️ partial |
| Re-engagement (stale-user email) | ❌ |

---

## 8. Cost + scale visibility

| Capability | Status |
|---|---|
| Per-target cost rollup | ❌ |
| Per-month spend forecast | ❌ |
| Tier quota enforcement | ⚠️ schema exists, partial |
| Token efficiency surface | ❌ |

---

## 9. Reporting / output formats

| Format | Status |
|---|---|
| In-app findings list | ✅ |
| CSV / JSON questionnaire export | ✅ |
| Compliance pack (zip) | ✅ |
| SBOM (CycloneDX) | ✅ |
| SARIF | ✅ (Phase A) |
| **PDF report** (pentest-engagement style) | ❌ |
| Executive summary (1-pager for leadership) | ❌ |
| GRC platform direct push | ✅ (Phase A) but no "Sent to Vanta on 2026-05-12" history view |

---

# Prioritized roadmap

Ranked by `impact × effort` for the brand thesis.

## Tier I — ship next (high impact, ≤ 1 week each)

| # | Item | Why | Effort | Status |
|---|---|---|---|---|
| **1** | `container_image` target type wrapper-side | Closes the 4th target type | 1 wk wrapper | ✅ PR #102 |
| **2** | Coverage matrix view on scan-detail (category × tool × result per target) | Trust signal — auditors / engineers both want it | 3 days | ✅ PR #103 |
| **3** | Tool freshness panel on scan-detail (Nuclei N templates · X hours ago) | Trust signal; ~zero engine work | 1 day | ✅ PR #103 |
| **4** | Engine reasoning trace on finding-card ("How did the agent arrive at this?") | Brand-aligned — proves it's an agent, not a scanner | 1 day | ✅ shipped inline as `TrajectorySection` |
| **5** | GRC templates for ISO 27001 + PCI DSS + NIST 800-53 (seed rows) | Unlocks enterprise procurement | 1 day per framework | ✅ PR #103 (39 SAQ rows seeded) |
| **6** | Per-finding assignee + due-date + simple comment thread | Closes team-workflow gap | 4 days | ✅ PR #103 |

## Tier II — ship Q1 (marquee features)

| # | Item | Effort |
|---|---|---|
| **7** | GitHub Action / GitLab CI template + PR comment bot | 5–7 days |
| **8** | **MCP server for Cursor / Claude Code** — vibe-coder brand alignment | 1 week |
| **9** | Onboarding wizard with stack detection (Vercel/Fly/Netlify) + repo→prod auto-pairing | 1 week |
| **10** | JIRA + Linear ticket creation | 4 days each |
| **11** | Cross-scan finding rollup ("this fingerprint hit 12 of your repos") | 3 days |
| **12** | Compliance "audit readiness" rollup score + quarterly snapshots | 1 week |
| **13** | Compensating controls + cross-framework mapping surface | 4 days |

## Tier III — Q2 follow-ups

| # | Item |
|---|---|
| 14 | Per-org custom Semgrep rule library |
| 15 | License compliance surface |
| 16 | Audit pack PDF (not just zip) |
| 17 | EPSS exploitability prioritization on findings |
| 18 | Multi-repo target group (B4 carry-over) |
| 19 | Stack-aware AI remediation (B8 carry-over) |
| 20 | Per-finding rescan (B6 — needs engine surface) |
| 21 | OWASP API9 improper inventory (shadow / deprecated endpoint detection) |
| 22 | HTTP request smuggling + cache-poisoning probes |
| 23 | SLSA provenance verification |
| 24 | Container image — layer hygiene, signing, base-image scorecard (depends on engine) |

---

## What "complete" looks like

After Tier I + II ship, the product is:

- **4 / 4 target types** with first-class UX (web_application, api,
  repository, container_image)
- **Coverage + tool + agent trust signals visible** on every scan
- **5 compliance frameworks** with full questionnaire templates
- **2 dev-loop integrations** (CI plugin + MCP) that no incumbent has both of
- **Cross-scan memory surfaced** as a feature, not an internal detail

Tier III closes the long-tail coverage gaps and the carry-over backlog
items. By Q2 end, the product is competitive on coverage, depth, and
workflow against Snyk / Semgrep / Aikido, and uniquely positioned on
the "vibe-coded apps" + MCP axis.

---

## Status as of this writing

- Phases **A / B / C** + apply-PR shipped (PR #99–#101)
- Phase A finish (A4 + A5) shipped (PR #100)
- Phase B shipped (PR #101)
- Engine PR #274 (`container_image`) merged upstream — wrapper-side
  implementation is the current in-flight work
