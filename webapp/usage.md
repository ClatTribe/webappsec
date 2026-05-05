# `usage.md` — wrapper product summary

> **About this doc.** This is the *wrapper-product* usage guide — what
> webappsec gives security engineers, compliance teams, and engineering
> managers, and how it compares to alternatives. The companion
> [`/usage.md`](../usage.md) at the repo root is the *engine team's*
> wrapper-integration guide written *by* the strix team *for* wrapper
> authors; this one is for users / buyers of the deployed product.
>
> Source-of-truth for tier-by-tier feature status: [`/roadmap.md`](../roadmap.md) §19.

---

## Table of contents

1. [What this product is](#1-what-this-product-is)
2. [Target types supported](#2-target-types-supported)
3. [Engine check categories × target type](#3-engine-check-categories--target-type)
4. [Wrapper-only features (the value over running strix yourself)](#4-wrapper-only-features)
5. [Why this is better than alternatives](#5-why-this-is-better-than-alternatives)
6. [The closed FP feedback loop](#6-the-closed-fp-feedback-loop)
7. [Honest gaps worth a buyer knowing](#7-honest-gaps-worth-a-buyer-knowing)
8. [Bottom line](#8-bottom-line)

---

## 1. What this product is

**An AI security engineer that replaces a junior pen-tester for routine
work.** Specifically: a multi-tenant SaaS wrapping the
[ClatTribe/strix](https://github.com/ClatTribe/strix) AI security agent.
The engine drives discovery + exploitation; the wrapper handles tenant
isolation, persistence, trust-signal rendering, false-positive feedback,
auditor handoff, cost control, and async push notifications.

Strix is single-tenant by design and writes structured artifacts to disk
([`vulnerabilities.json`](../usage.md#23-reading-vulnerabilitiesjson-the-finding-stream),
`run_meta.json`, `coverage.json`, `compliance_pack/`, `sbom.cdx.json`,
`trajectory.jsonl`, etc.). The wrapper consumes those artifacts
verbatim, never re-deriving what the engine already produces (per
[Architecture.md §1.1](Architecture.md#11-design-principles)). Adding a
new engine signal is a UI change, not a schema change.

The product is **what makes it safe to run thousands of scans across
hundreds of orgs** — vault-encrypted secrets, RLS-isolated storage, per
SECURITY-DEFINER RPCs, audit-logged sensitive actions, signed
events.jsonl chain.

---

## 2. Target types supported

| Target type | Best for | Examples | Initial input |
|---|---|---|---|
| `domain` | External attack surface mapping, vendor-risk scoring, brand monitoring | `getedunext.com`, `acme.io` | Bare apex domain |
| `web_application` | Active web pentest — crawl + exploit | `https://app.example.com`, `https://api.example.com/v1` | Full URL (HTTP/HTTPS) |
| `repository` | SAST + secret scanning + IaC review on a clone | `https://github.com/acme/api`, `git@gitlab.com:acme/web.git` | Git URL + optional `--branch` |
| `local_code` | Pre-commit / pre-push scanning of an unpushed working copy | `/Users/dev/myproject` | Local filesystem path |
| `ip_address` | Network / infra pentest, including CIDR ranges | `203.0.113.42`, `10.0.0.0/24`, `2001:db8::/48` | Single IP or CIDR (host-count chip in UI) |

Plus **HAR / Burp project upload** as a per-scan input on top of any
target — drag-drop a `.har` or `.xml` file (≤50 MiB, ≤5 files) and the
engine ingests it before its own recon. The "every pen-test starts with
a Burp recording" on-ramp.

---

## 3. Engine check categories × target type

| Category | What's covered | Domain | Web app | Repo | Local | IP |
|---|---|:-:|:-:|:-:|:-:|:-:|
| **Subdomain enum** | Passive (CT logs, intel feeds), zone-transfer, DNS brute, source-maps reflection | ✅ | – | – | – | – |
| **Passive DNS history** | SecurityTrails / VirusTotal lookups | ✅ | ✅ | – | – | ✅ |
| **DNS hygiene** | DNSSEC algorithm strength + RRSIG freshness, SVCB/HTTPS records, IDN homographs, IPv6/AAAA asymmetry | ✅ | ✅ | – | – | – |
| **Email security** | SPF, DKIM, DMARC, MTA-STS | ✅ | ✅ | – | – | – |
| **Subdomain takeover** | Dangling-CNAME detection across CDN/SaaS providers | ✅ | – | – | – | – |
| **DNS rebinding** | Feasibility check (TTL behaviour, public-IP DNS pinning) | ✅ | ✅ | – | – | – |
| **Code search recon** | GitHub/GitLab `q=org:<x>` for leaked secrets / private endpoints | ✅ | ✅ | – | – | – |
| **SaaS leak discovery** | Bing-API queries against Trello, Notion, Pastebin, Confluence Cloud, Google Drive, Airtable | ✅ | ✅ | – | – | – |
| **TLS audit** | Cipher suites, cert validity, HSTS, OCSP, ALPN, ECH | ✅ | ✅ | – | – | ✅ |
| **Port / service detection** | nmap-driven scan with version detection, scoped by ports config | – | – | – | – | ✅ |
| **WebSocket audit** | Auth on upgrade, origin enforcement, subprotocol echo | – | ✅ | – | – | – |
| **MFA enforcement attestation** | 4-point posture: login_tokens, challenge_keys, webauthn_header, mfa_setup_paths | – | ✅ | – | – | – |
| **Logging / monitoring posture** | 6-point: PII / secrets / auth-token redaction, CSP report-uri, error pipeline, rate-limit | – | ✅ | – | – | – |
| **Legal-document presence** | Privacy, cookie, terms, DPA, imprint, accessibility | ✅ | ✅ | – | – | – |
| **Vendor-risk score** | 0-100 score with 6 deduction categories | ✅ | ✅ | – | – | ✅ |
| **OWASP Top 10 (A01-A10)** | BAC/IDOR, crypto failures, injection, insecure design, misconfig, vuln components, auth failures, data integrity, logging, SSRF | – | ✅ | ✅ | ✅ | – |
| **XSS** | Reflected, stored, DOM-XSS static probe (engine PR #108) | – | ✅ | – | – | – |
| **SQLi / NoSQLi / cmd injection** | Injection attempts at all observed input points | – | ✅ | ✅ | ✅ | – |
| **CSRF + SameSite policy** | Token validation, double-submit, header-only mitigations | – | ✅ | – | – | – |
| **Open redirect** | Reflected location-header redirects | – | ✅ | – | – | – |
| **Path traversal / LFI / RFI** | Filesystem boundary crossing in upload + URL params | – | ✅ | ✅ | ✅ | – |
| **SSRF + cloud metadata** | Outbound URL injection, IMDS/169.254 detection | – | ✅ | ✅ | ✅ | – |
| **XXE / template injection / deserialization** | XML parsing weaknesses, Jinja/EL/Java serialization | – | ✅ | ✅ | ✅ | – |
| **API auth** | BOLA, BFLA, BOPLA, mass assignment, rate-limit absence | – | ✅ | ✅ | ✅ | – |
| **JWT / session** | Algorithm-confusion, expiration, fixation, scope leakage | – | ✅ | ✅ | – | – |
| **Cross-subdomain cookie/JWT** | Scope confusion across siblings (engine PR #109) | ✅ | ✅ | – | – | – |
| **Cohort session audit** | Session-ID predictability across user pool | – | ✅ | – | – | – |
| **Secrets scan** | GitHub PATs, AWS keys, Stripe, generic high-entropy + 30+ vendor patterns; vendor-keyed rotation playbooks (engine PR #115) | – | ✅ | ✅ | ✅ | – |
| **Source-map exposure** | `.js.map` files revealing internal structure | – | ✅ | – | – | – |
| **SBOM (CycloneDX 1.5)** | Component fingerprinting from CDN URLs, headers, HTML markers, package.json | – | ✅ | ✅ | ✅ | – |
| **HAR / Burp ingestion** | Auto-dedup per (method, canonical-URL) + auth-class detection | – | ✅ | – | – | – |
| **Compliance control mapping** | Per-finding tags: PCI / SOC2 / HIPAA / ISO 27001 / NIST 800-53 / GDPR / OWASP | – | ✅ | ✅ | ✅ | – |
| **Audit-trail signing** | HMAC chain over events.jsonl + run.signature.json | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Compliance evidence pack** | 7-file auditor bundle (manifest, control attestation, coverage report, findings.csv/.json, signed events excerpt, scan_metadata, signature.txt) | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 4. Wrapper-only features

Everything in this section is what the wrapper **adds on top** of the
engine. Run `strix` directly and you get the per-target scan — but none
of multi-tenancy, persistence, trust-signal composition, FP feedback
closure, auditor handoff, or async notifications.

### 4.1 Multi-tenant infrastructure (the wrapper's reason to exist)

| Feature | What it does | Why it matters |
|---|---|---|
| **Org-scoped RLS** | Every table + storage path keyed on `org_id`; `current_org_id()` from JWT enforces tenant isolation server-side | Run thousands of scans across hundreds of orgs without leakage |
| **Vault-encrypted secrets** | Per-org LLM API key, Slack webhook, 5 STRIX_* threat-intel keys (`GITHUB_TOKEN`, `BING_KEY`, `SECURITYTRAILS_KEY`, `VIRUSTOTAL_KEY`, `VIEWDNS_KEY`) — pointer-based, never plaintext | No keys in scan logs / events.jsonl / Slack messages |
| **Service-role-only worker RPCs** | 12 SECURITY DEFINER RPCs scoped to single mutations | Worker never gets RLS-bypass write to anything outside its scan row |
| **Audit log on every sensitive action** | `audit_log` rows for scan-start, secret-set/unset, compliance-pack-download, finding-verify-rescan | Compliance teams get a who-did-what trail |

### 4.2 Live scan UX

| Feature | What it does | Why it matters |
|---|---|---|
| **Phase progress strip** | Recon → Exploit → Validate → Report tiles with `categories_covered` chips per phase | Operator sees "is the engine working?" at a glance |
| **Hypothesis pane** | Real-time list of `hypothesis.opened` / `confirmed` / `dismissed` events with surface, category, agent | Watching a senior pen-tester work, not log-tail |
| **Provenance badges** | 6-value `actor.provenance` chip on every tool call (`trusted_source` / `intel_feed` / `target` / `operator_input` / `framework` / `mixed`) | Trust-boundary map across all agent activity |
| **Indirect-prompt-injection alert** | Detects `target → non-target` boundary crossings within an agent's history | Catches the "engine consumed adversary-controlled response" class |
| **Per-target progress chips** | Reads `target.started`/`target.completed` events | Multi-target scans don't look stalled |
| **Test-plan checklist** | Renders engine's `run.test_plan` event up-front | "What categories will be tested" before findings exist |
| **Self-audit gate-breach banner** | Surfaces `agent.self_audit.categories_skipped` / `concern` / `stuck_sub_agents` | Pen-test gaps you'd otherwise discover after the report |
| **Upstream rate-limited banner** | 1-second-tick countdown when `llm.retry_attempted` fires | "Is the engine stuck?" no longer asked |

### 4.3 Per-finding casefile

| Feature | What it does | Why it matters |
|---|---|---|
| **Confidence bar** | 0.0-1.0 from engine's `verification_status` | Auditor-grade trust signal |
| **Reasoning trace** | "Why we believe this is exploitable" — ≤20 bullets × 320 chars from agent | Single biggest "is this AI talking to me, or guessing?" tell |
| **Counter-proof block** | "Possible alternative explanation" — engine's adversarial self-check | Increases finding trust massively |
| **Kill chain** | 7-step typed (recon / discovery / exploitation / escalation / lateral_movement / impact / validation) | Replaces wrapper's old time-window heuristic with deterministic chain |
| **Reasoning trail (trajectory)** | Per-finding `iterations_to_emit` / `time_to_emit_seconds` / `dismissed_alternatives[]` with reasons + provenance | "How did the engine arrive at this?" — labeler grading + FP-classifier signal |
| **Engine auto-dismiss banner** | Slate banner "Auto-dismissed — labeler marked an identical finding as `<fp_reason>` on `<date>` by `<labeler>`" | FP feedback loop visible — closes the trust loop with prior triage |
| **Force-show / re-promote** | One-click flip to `triaged_real`; lands a `verdict=tp` signal that next scan's `feedback.jsonl` carries | Override the auto-dismiss explicitly |
| **Verify fix button** | Spawns a focused `quick`-mode rescan with original finding context | The engineer's "I fixed it; verify" loop |
| **Cross-scan dedup** | Fingerprint + `reproducibility_token` thread the same finding across scans (`times_seen`, `reopened_count`, last/first seen) | Continuous casefile, not 47 separate scan reports |

### 4.4 Compliance handoff

| Feature | What it does | Why it matters |
|---|---|---|
| **Compliance pack ZIP** | One-click download of the engine's 7-file auditor bundle with audit-logged event | Auditor-grade evidence — the single biggest B2B-sale unlock |
| **Compliance overlay** | Findings grouped by 7 frameworks (PCI / SOC2 / HIPAA / ISO 27001 / NIST 800-53 / GDPR / OWASP) | "Which controls have findings?" view auditors actually use |
| **Vendor-risk gauge** | 0-100 score with band + top-3 deduction categories | Procurement question answered without leaving the dashboard |
| **MFA posture badge** | 4-point score with breakdown chips + copy-paste auditor attestation line | "Show me MFA is enforced" answer |
| **Compliance posture card** | Cadence status + audit-log retention + days-since-last-scan | "Are you on cadence?" answer |
| **Monitoring posture badge** | 6-point logging score (PII / secrets / auth-token redaction + CSP report-uri + error pipeline + rate-limit) | "Are you logging the right things and protecting the wrong ones?" |
| **Coverage banner** | Amber warning when engine's `coverage_percent < 100%` or `status=incomplete` | **Trust-gap fix:** 0-finding ≠ clean bill of health when checks didn't run |
| **SBOM viewer + CycloneDX export** | Sortable / filterable table + `?format=cyclonedx` raw download | Supply-chain audit handoff |

### 4.5 Cost / safety / ops

| Feature | What it does | Why it matters |
|---|---|---|
| **Per-scan cost cap** | `--max-cost <USD>` + `--max-input-tokens <N>` plumbed through; engine self-exits with code 3 | No surprise LLM bills |
| **Budget-exceeded UX** | Distinct amber failure card (not red) with "raise budget and rerun" CTA | Helps operator choose between "raise budget" and "investigate logs" |
| **Cancel → SIGTERM** | UI button → `request_scan_cancel` RPC → `pg_notify` → worker `SIGTERM` → engine flushes events + exits 143 → status flips cancelled | Cost control + trust |
| **Heartbeat + stale-scan sweep** | Worker ticks every 60s; sweep marks running-but-silent scans as failed | Stuck workers don't dangle scans |
| **Concurrency-bounded worker** | Semaphore-based dispatch; survives pod restart via startup sweep | Reliable at scale |

### 4.6 Workflow

| Feature | What it does | Why it matters |
|---|---|---|
| **HAR / Burp upload** | Browser uploads to user-uploads bucket; worker copies into `<workdir>/imports/`; instruction-line tells agent to call `ingest_har_file` / `ingest_burp_file` | Pen-test on-ramp — every real engagement starts here |
| **Fix-verify targeted rescan** | "Verify fix" button on FindingCard → focused quick-mode scan; new scan deep-links back to original finding | Closes the find→fix→verify engineer loop |
| **Slack notifications** | Severity-aware emoji (🚨/⚠️/✅/🛑/💸/❌) + counts + cost + deep-link button | Operator doesn't sit on dashboard |
| **CI / CD snippet generator** | GitHub Actions / GitLab CI YAML with `--quiet` mode + exit-code semantics | Power users running strix in their own pipeline |
| **Branch picker** | Free-text branch / tag / SHA for repository targets | "Scan the feature branch before merge" |
| **CIDR target preview** | Host-count chip on every IP-with-slash target | "/24 = 256 hosts" visible BEFORE submit |
| **DNS-only / passive recon mode** | "Surface-map only" toggle for domain targets | Pre-authorisation surface mapping or compliance sweeps |

---

## 5. Why this is better than alternatives

### 5.1 vs. traditional DAST (OWASP ZAP / Burp Suite Enterprise / Acunetix / Netsparker)

| Dimension | Traditional DAST | This product |
|---|---|---|
| Coverage choice | Static scanner-config rules | LLM agent picks tests based on observed surface — adapts to your stack |
| Output | Long list of findings | Per-finding casefile: confidence + reasoning trace + counter-proof + kill chain + trajectory |
| FP rate | High; needs human triage every scan | Closed FP feedback loop — engine remembers prior labels, auto-dismisses re-emerging FPs |
| Cross-scan memory | None — each scan is fresh | Fingerprint + `reproducibility_token` dedup; finding "seen 3× across runs" |
| Compliance handoff | Manual — copy-paste into a Word doc | One-click ZIP with manifest, control_attestation.md, signed events.jsonl |
| Recon scope | Surface scan only | Includes passive DNS, code search, SaaS leak discovery, subdomain takeover |
| Audit trail | Logs sometimes | HMAC-chain signed `events.jsonl` + `run.signature.json` |

### 5.2 vs. ASM tools (Detectify / SecurityScorecard / Bishop Fox CAST / Hardenize)

| Dimension | ASM tools | This product |
|---|---|---|
| Depth | Surface mapping + drift detection | Goes beyond mapping into actual exploit attempts |
| Reasoning | Rule-based; here's what we observed | Per-finding "Why we believe this is exploitable" + counter-proof block |
| Cost model | Per-asset annual subscription | Per-scan LLM cost (~$0.50-2 typical, configurable cap) |
| Vendor-risk score | Yes (0-100 typical) | Yes (engine PR #133) — same dimension |
| Compliance pack | Sometimes | Yes — engine PR #129 8-file bundle, signed |
| Active testing | No (passive only) | Yes (when target type is `web_application` / `repository` / etc.) |

### 5.3 vs. AI-only tools (basic GPT pentest wrappers, vibe-coded scanners)

| Dimension | Naive AI scanner | This product |
|---|---|---|
| Multi-tenant | Often single-user | RLS-isolated by design; vault-encrypted secrets per org |
| Trust signals | Black-box "AI found N issues" | Confidence + reasoning_trace + counter_proof + provenance per finding |
| FP loop | None — repeats the same FPs | Closed loop with engine; org-specific labels carry forward |
| Audit | LLM hallucinations + no chain of custody | HMAC-chained event log + signed run.signature.json |
| Compliance evidence | Marketing copy | Auditor-grade ZIP with manifest + control attestations + signed excerpt |
| Cost control | None — surprise bills | `--max-cost` self-exit + budget-exceeded UX |
| Coverage honesty | Reports clean even when nothing ran | Coverage banner on `coverage_percent < 100%` (prevents the most common AI-tool lie) |

### 5.4 vs. doing nothing / pure manual pentest engagement

| Dimension | Manual pentest | This product |
|---|---|---|
| Cadence | 1-2× per year | Continuous; nightly cron available |
| Wall time | 1-2 weeks | 5-90 min depending on mode + budget |
| Cost | $5k-$50k per engagement | $0.50-$2 per scan |
| Cross-engagement memory | "Remember the SSRF we found in Q3?" requires reading old reports | Cross-scan dedup makes recurrence visible automatically |
| Auditor handoff | Manually-formatted PDF | Same auditor-grade ZIP every scan, signed |
| Operator skill required | Senior pen-tester | Anyone who can read the FindingCard |
| Real-world findings still need a human | Yes — pentesters find creative bugs LLMs miss | Yes — but the AI does the 80% of routine checks so humans focus on the 20% creative |

---

## 6. The closed FP feedback loop

The single most differentiated thing this product does. Here's the
end-to-end:

| Stage | What happens | Where |
|---|---|---|
| 1. **Operator triages a finding** | Marks `fixed` / `false_positive` / `wont_fix` / `triaged_real` on the FindingCard | Migration-018 trigger captures every label as a `triage_signals` row |
| 2. **Worker writes feedback.jsonl on next scan-start** | `worker_feedback_jsonl_for_org(p_org_id)` RPC renders the org's labels as engine-shape JSONL → writes to `<workdir>/feedback.jsonl` | [`runner.py` `_write_feedback_jsonl`](worker/src/strix_worker/runner.py) |
| 3. **Worker forwards to engine** | `--feedback-from <path>` + `STRIX_FEEDBACK_FROM=<path>` env | `_build_cmd` |
| 4. **Engine auto-dismisses re-emerging fingerprints** | Per the org's `fp_auto_dismiss_policy` (`off` / `conservative` / `aggressive`) | Engine PR #142 |
| 5. **UI renders auto-dismiss banner** | Slate banner on FindingCard with attribution: labeler id + role + original `fp_reason` + date | [`finding-card.tsx`](frontend/components/finding/finding-card.tsx) |
| 6. **User force-shows if it's actually different** | "Force-show — this one's different" button → flips status to `triaged_real` | Lands a new `verdict=tp` label that closes back via step 1 |

**Net effect:** the next scan after every triage decision treats the
operator's call as gospel. The engine doesn't re-emit the same FPs; it
doesn't waste LLM budget probing fingerprints the org has already
labeled `wont_fix`. The labeling round-trip is the **only** state the
wrapper has to manage; the engine handles auto-dismiss, the wrapper
handles the override, and `feedback.jsonl` is the wire between them.

---

## 7. Honest gaps worth a buyer knowing

| Gap | Status | Impact |
|---|---|---|
| **Agent gives up early on web-app probing** | 🔴 Engine-side, [strix #146 filed](https://github.com/ClatTribe/strix/pull/146) | Web app scans against well-defended sites (Vercel/Cloudflare-hosted) tend to fail with `ConnectError` and produce 0 findings. Wrapper's coverage banner now flags this; engine fix pending. |
| **`run.test_plan` checkboxes don't tick off** | 🟡 Blocked upstream — engine needs to emit `check.completed` events | Operator sees the plan but not the live progress through it. |
| **Sandbox image is 13.3 GB** | 🟡 Ops gate; the user's `docker builder prune` discipline matters | First-time pull is heavy; subsequent scans cached. |
| **Audit-trail verification UI** | 🟡 Engine emits `run.signature.json`, wrapper doesn't yet have a verify-by-paste UI | Auditors can verify offline with a script; the in-app affordance is a deferred Tier-4 row. |
| **GRC SaaS one-click upload** (Vanta/Drata/etc.) | 🟡 Per-platform partnership work | Manual download + upload for now via the compliance pack ZIP. |
| **Cross-run SBOM diff** | 🟡 Needs prior-scan SBOM resolution per target | Per-run SBOM works; compare-across-runs ⬜. |
| **Per-target negative-coverage report** | 🟡 Wrapper has the data (`coverage.json`) but the per-endpoint ledger is the deferred half of the trust-gap fix ([webappsec PR #64](https://github.com/ClatTribe/webappsec/pull/64)) | Per-scan coverage works; per-target/per-endpoint ⬜. |

The wrapper-side trust-gap fix
([PR #64](https://github.com/ClatTribe/webappsec/pull/64)) ensures that
even when the engine has issues like the ones flagged above, the
operator sees an amber "coverage incomplete — 0-finding ≠ clean" banner
instead of a misleading "100/100 vendor risk" card. Per
[Architecture.md §1.1](Architecture.md#11-design-principles), the
wrapper's job here is to make engine failures visible, not paper over
them.

---

## 8. Bottom line

**For a security engineer / compliance officer / engineering manager:**
this is the most complete AI-pentest integration in the open ecosystem.
Recon depth (subdomains + code search + SaaS leaks) + active testing
depth (OWASP Top 10 + API + WebSocket + WebAuthn) + auditor handoff
(signed compliance pack + SBOM + control mappings + audit-trail) +
closed FP feedback loop is unique. The wrapper's job — multi-tenancy,
trust-signal rendering, FP loop closure, compliance pack delivery, cost
gating, async push notifications — is the moat that turns a single-user
CLI into a B2B-sellable SaaS.

**Real-world caveat:** when the sandbox tool-server flaps (which
happens against some hosts, see [strix
#146](https://github.com/ClatTribe/strix/pull/146)), the engine
self-reports honestly but its exit-code semantics need tightening. The
wrapper's coverage banner closes the trust gap from the buyer side; the
upstream engine fix is filed.

---

## Pointers

| Doc | What's there |
|---|---|
| [`README.md`](README.md) | Quickstart for running the wrapper locally |
| [`Architecture.md`](Architecture.md) | Tenant-isolation model + design choices to preserve |
| [`/usage.md`](../usage.md) | Engine team's wrapper-integration guide (what the engine emits) |
| [`/wrapper-wishlist.md`](../wrapper-wishlist.md) | Per-PR rendering specs from the engine team |
| [`/roadmap.md`](../roadmap.md) §19 | Tier-by-tier feature status (✅ / 🚧 / ⬜) |
| [`/tools-wishlist.md`](../tools-wishlist.md) | Engine PRs the wrapper would like (upstream asks) |
| [`/CLAUDE.md`](../CLAUDE.md) | Agent guide: doctrine + operational habits |

Last updated: 2026-05-05 (after PRs #46–#64).
