# Strix Roadmap

A prioritized plan to close the gaps between Strix today and a complete, enterprise-grade, developer-to-CISO security testing platform.

Each item lists the **gap**, the **customer pain** it solves, and **what "done" looks like**. Ordered strictly by impact × number of blocked customers — highest first.

---

## Table of Contents (by Priority)

### P0 — Blocks adoption today
1. [SARIF / GitHub Code Scanning Output](#1-sarif--github-code-scanning-output)
2. [Compliance-Mapped Reporting (OWASP, CWE, PCI, SOC 2)](#2-compliance-mapped-reporting-owasp-cwe-pci-soc-2)
3. [Expand CI/CD Integrations Beyond GitHub Actions](#3-expand-cicd-integrations-beyond-github-actions)
4. [Authenticated-Scan Recording & Replay](#4-authenticated-scan-recording--replay)
5. [Baseline / Findings Triage & Suppression](#5-baseline--findings-triage--suppression)
6. [Resumable Scans & Checkpointing](#6-resumable-scans--checkpointing)
7. [Broaden Vulnerability Skill Library](#7-broaden-vulnerability-skill-library)

### P1 — Required for enterprise/scale customers
8. [Strix REST API & Webhook Server](#8-strix-rest-api--webhook-server)
9. [Remote / Self-Hosted Sandbox Runtime](#9-remote--self-hosted-sandbox-runtime)
10. [Multi-Scan Orchestration & Queueing](#10-multi-scan-orchestration--queueing)
11. [Cloud-Provider Skill Packs (AWS / Azure / GCP / Terraform / IaC)](#11-cloud-provider-skill-packs-aws--azure--gcp--terraform--iac)
12. [Language & Framework Skill Packs](#12-language--framework-skill-packs)
13. [Protocol Skill Packs (gRPC, WebSocket, SOAP, OAuth, SAML)](#13-protocol-skill-packs-grpc-websocket-soap-oauth-saml)
14. [Secrets Vault Integration (HashiCorp, AWS SM, 1Password, Vault)](#14-secrets-vault-integration-hashicorp-aws-sm-1password-vault)
15. [Supply-Chain & Dependency Scanning](#15-supply-chain--dependency-scanning)
16. [IDE Extensions (VS Code, JetBrains)](#16-ide-extensions-vs-code-jetbrains)

### P2 — Platform breadth & polish
17. [Autofix in the CLI (fix-it command)](#17-autofix-in-the-cli-fix-it-command)
18. [Custom Report Templates & Export Formats](#18-custom-report-templates--export-formats)
19. [Local Web Dashboard](#19-local-web-dashboard)
20. [Scheduled & Continuous Scanning](#20-scheduled--continuous-scanning)
21. [Mobile Application Testing (iOS / Android)](#21-mobile-application-testing-ios--android)
22. [Container Image & Kubernetes Manifest Scanning](#22-container-image--kubernetes-manifest-scanning)
23. [Diff Reports Between Scans](#23-diff-reports-between-scans)
24. [Air-Gapped / Offline Mode](#24-air-gapped--offline-mode)

### P3 — Enterprise hardening & operability
25. [RBAC, SSO, Audit Log for Self-Hosted Deployments](#25-rbac-sso-audit-log-for-self-hosted-deployments)
26. [Prompt-Injection & Scope-Escape Defense](#26-prompt-injection--scope-escape-defense)
27. [Cost Governance & Budget Controls](#27-cost-governance--budget-controls)
28. [Observability: Grafana Dashboards & Log Pipelines](#28-observability-grafana-dashboards--log-pipelines)
29. [Benchmark & Regression Harness](#29-benchmark--regression-harness)
30. [Alternative Container Runtimes (Podman, containerd, K8s Jobs)](#30-alternative-container-runtimes-podman-containerd-k8s-jobs)

### P4 — Long-horizon differentiators
31. [Fine-Tuned & Self-Hosted Model Guides](#31-fine-tuned--self-hosted-model-guides)
32. [Knowledge Retention Across Scans (Org Memory)](#32-knowledge-retention-across-scans-org-memory)
33. [Attack Chain Visualization & Kill-Chain Graphs](#33-attack-chain-visualization--kill-chain-graphs)
34. [Browser Extension for Manual Testers](#34-browser-extension-for-manual-testers)
35. [Red-Team Campaign Mode](#35-red-team-campaign-mode)

---

## P0 — Blocks Adoption Today

### 1. SARIF / GitHub Code Scanning Output

**Gap.** The only machine-readable output today is the JSON inside `strix_runs/<run>/`. Teams using GitHub Advanced Security, GitLab Vulnerability Reports, Azure DevOps, or any SAST dashboard cannot ingest Strix findings.

**Customer pain.** Blocks adoption as the "SAST/DAST" in existing security dashboards. Every prospect with an AppSec program asks for SARIF on the first call.

**Done = **
- `strix --output sarif` emits a valid SARIF 2.1.0 file.
- GitHub Actions example uploads it to `github/codeql-action/upload-sarif@v3`.
- Rule metadata includes CWE, OWASP category, severity, and CVSS.
- Location data includes file + line when the finding is source-aware; request/response artifact when it's black-box.

---

### 2. Compliance-Mapped Reporting (OWASP, CWE, PCI, SOC 2)

**Gap.** Findings carry a CVSS score only. There's no CWE ID, no OWASP Top 10 mapping, no PCI-DSS / SOC 2 / HIPAA / ISO 27001 control mapping.

**Customer pain.** Regulated industries (fintech, healthcare, govtech) require compliance mapping on every finding to close the loop with auditors.

**Done = **
- Each `VulnerabilityReport` schema gains `cwe`, `owasp_top_10`, `compliance` fields.
- Generated PDF/HTML reports group findings by compliance framework.
- A `--compliance-profile pci|hipaa|soc2|iso27001` flag biases the agent toward controls that framework cares about.

---

### 3. Expand CI/CD Integrations Beyond GitHub Actions

**Gap.** README ships a GitHub Actions example only. GitLab, Jenkins, CircleCI, Azure DevOps, Bitbucket, Buildkite users have to roll their own.

**Customer pain.** Roughly 40% of prospects are GitLab-first or on-prem Jenkins. They need a turnkey pipeline, not a bash recipe.

**Done = **
- First-party recipes + copy-paste configs for GitLab CI, Jenkins (declarative + scripted), CircleCI, Azure DevOps, Bitbucket Pipelines.
- Published reusable GitHub Action (`usestrix/strix-action@v1`) with typed inputs/outputs.
- Auto-detection of CI environment extended from `GITHUB_ACTIONS` to all major providers so diff-scope works out of the box.

---

### 4. Authenticated-Scan Recording & Replay

**Gap.** Grey-box scans depend on passing credentials in `--instruction`. There's no way to capture a real login (SSO redirects, MFA, CAPTCHA-guarded flows) and replay it in the browser tool.

**Customer pain.** Most real applications hide behind SSO. Without this, Strix cannot test the authenticated surface — which is where IDOR, privilege escalation, and business-logic bugs live.

**Done = **
- `strix record-auth --target https://app` opens a real browser, records actions + cookies + localStorage.
- Output stored as an encrypted session artifact reusable across scans.
- Browser tool auto-loads recorded sessions.
- TOTP/MFA helper: feed a TOTP secret and the agent can generate codes during replay.

---

### 5. Baseline / Findings Triage & Suppression

**Gap.** Every run reports the same findings from scratch. There's no way to mark "accepted risk" or "known issue tracked in JIRA-1234" so it stops failing the PR.

**Customer pain.** After the first scan, teams need to whitelist stubborn findings or the scanner becomes noise and gets disabled.

**Done = **
- `.strixignore` file with pattern-matched suppressions (by CWE, path, URL, fingerprint).
- `strix triage` subcommand to review new findings interactively.
- Stable fingerprinting so cosmetic changes don't reopen findings.
- Exit code semantics: "new findings above threshold" vs "any findings".

---

### 6. Resumable Scans & Checkpointing

**Gap.** If a scan dies (CI timeout, OOM, user Ctrl-C, LLM outage) you start over. Long deep scans on 100k-LOC monorepos can burn hours of LLM spend.

**Customer pain.** Big scans are economically risky. Teams avoid `--scan-mode deep` because of this.

**Done = **
- Periodic checkpoint of `AgentState` + agent-graph to disk.
- `strix resume <run-name>` picks up where it stopped.
- Auto-resume on transient LLM errors instead of failing the iteration.

---

### 7. Broaden Vulnerability Skill Library

**Gap.** Current skills cover ~17 classes (SQLi, XSS, SSRF, XXE, IDOR, RCE, CSRF, JWT, race, LFI/RFI, mass assignment, open redirect, subdomain takeover, info disclosure, file upload, business logic, broken FLA). Missing or thin:

- **Template injection (SSTI)** — Jinja2, Handlebars, Freemarker, Thymeleaf.
- **NoSQL injection** — deep Mongo/Redis/Couch playbook.
- **LDAP / XPath injection.**
- **HTTP request smuggling & desync.**
- **Web-cache poisoning / deception.**
- **CORS & CSP misconfiguration.**
- **Clickjacking & UI redressing.**
- **OAuth / OIDC flaws** (redirect_uri, PKCE downgrade, state reuse).
- **SAML flaws** (signature wrapping, replay).
- **Prototype pollution** (server- and client-side).
- **MFA bypass & session fixation.**
- **Rate-limit & password-reset abuse.**
- **API abuse** (mass enumeration, pagination limits).

**Customer pain.** Coverage directly equals value. Prospects evaluate Strix by "does it find the class of bugs we care about?"

**Done = ** A first-class Markdown skill for each class in [strix/skills/vulnerabilities/](https://github.com/usestrix/strix/blob/main/strix/skills/vulnerabilities) with payloads, validation, and false-positive filters.

---

## P1 — Required for Enterprise / Scale Customers

### 8. Strix REST API & Webhook Server

**Gap.** Strix is a CLI. There's no way for a SOAR, a ChatOps bot, or an internal portal to start a scan programmatically and receive findings via webhook.

**Customer pain.** Platform teams want "scan as a service" for their developers — a button in Backstage/Port that triggers Strix and posts results to Slack + Jira.

**Done = **
- `strix serve` launches a FastAPI service exposing `POST /scans`, `GET /scans/{id}`, `GET /scans/{id}/findings`, `DELETE /scans/{id}`.
- Webhook callbacks (`X-Strix-Signature`) on scan lifecycle events and each new finding.
- OpenAPI spec + TypeScript and Python client libraries.

---

### 9. Remote / Self-Hosted Sandbox Runtime

**Gap.** [`DockerRuntime`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) is the only implementation of [`AbstractRuntime`](https://github.com/usestrix/strix/blob/main/strix/runtime/runtime.py). Enterprises with no local Docker (regulated laptops, cloud IDEs, VDI) cannot run Strix.

**Customer pain.** No-Docker-on-laptop policy blocks rollout in banks, defense, healthcare. Also nobody wants a 2GB download on an 8-core CI runner.

**Done = **
- `KubernetesRuntime` — launches the sandbox as a K8s Job in the user's cluster.
- `FargateRuntime` / `CloudRunRuntime` for serverless execution.
- `RemoteRuntime` — BYO managed Strix sandbox pool (`STRIX_SANDBOX_ENDPOINT=wss://...`).
- Clear deployment guides for each.

---

### 10. Multi-Scan Orchestration & Queueing

**Gap.** A single `strix` invocation is one scan. There's no concept of a fleet of scans, no priority queue, no concurrency control, no resource budgeting.

**Customer pain.** Platform teams scanning hundreds of repos nightly need backpressure and scheduling — otherwise they DDoS their own LLM quota and Docker host.

**Done = **
- Worker mode: `strix worker --queue redis://...`.
- Job enqueue CLI + API.
- Per-job and global concurrency limits, retries, dead-letter queue, run metadata store.

---

### 11. Cloud-Provider Skill Packs (AWS / Azure / GCP / Terraform / IaC)

**Gap.** [strix/skills/cloud/](https://github.com/usestrix/strix/blob/main/strix/skills/cloud) contains only `kubernetes.md`. No AWS (IAM, S3 public buckets, Lambda perms, RDS snapshots, Cognito), no Azure (Entra ID, storage, Functions), no GCP (IAM, GCS, Cloud Functions), no Terraform/CloudFormation IaC analysis.

**Customer pain.** Cloud misconfiguration is the #1 breach cause. Prospects expect the tool to cover it.

**Done = **
- New skill packs: `aws_iam`, `aws_s3`, `aws_lambda`, `aws_rds`, `aws_cognito`, `azure_entra`, `azure_storage`, `gcp_iam`, `gcp_gcs`, `terraform`, `cloudformation`.
- A `source_aware_iac` coordination skill that triages `.tf`, `.yaml`, `.bicep` files in white-box scans.

---

### 12. Language & Framework Skill Packs

**Gap.** [frameworks/](https://github.com/usestrix/strix/blob/main/strix/skills/frameworks) has only FastAPI, NestJS, Next.js. No Django, Flask, Rails, Spring, Laravel, Express, ASP.NET, Go (Gin/Echo/Fiber), Phoenix. No language-level packs for Java, .NET, Go, Rust, Ruby, PHP.

**Customer pain.** Findings quality is much higher when the agent knows the idioms of the target stack.

**Done = ** 12+ new framework skills + 5 new language skills, each with sink/source mappings, auth middleware patterns, and common footguns.

---

### 13. Protocol Skill Packs (gRPC, WebSocket, SOAP, OAuth, SAML)

**Gap.** [protocols/](https://github.com/usestrix/strix/blob/main/strix/skills/protocols) contains `graphql.md` only. Modern stacks use gRPC, WebSocket, MQTT, SOAP, OData, JSON-RPC, HTTP/2 server push.

**Customer pain.** API-first companies are non-REST — without first-class support Strix gets dropped after the eval.

**Done = ** Protocol skill + a matching sandbox-side client (for gRPC, WebSocket) the agent can drive from the terminal/Python tool.

---

### 14. Secrets Vault Integration (HashiCorp, AWS SM, 1Password, Vault)

**Gap.** Credentials pass through `--instruction` or env vars. There's no structured secrets provider, no rotation, no audit log of what creds a scan used.

**Customer pain.** Security teams won't let credentials sit in `~/.strix/cli-config.json`. Dealbreaker for regulated industries.

**Done = **
- `strix://vault/<path>` references resolved at scan start.
- Support HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, 1Password Connect, Doppler.
- Secrets never written to disk, redacted in logs, never sent to the LLM unless explicitly referenced.

---

### 15. Supply-Chain & Dependency Scanning

**Gap.** `source_aware_sast` does semgrep and secrets triage but there's no first-class dependency vulnerability check (equivalent to `npm audit`, `pip-audit`, `osv-scanner`, `trivy fs`).

**Customer pain.** Most breaches come through transitive dependencies. Ignoring them makes Strix look incomplete vs. Snyk/Dependabot.

**Done = **
- New `supply_chain` skill + bundled OSV / GHSA / NVD feeds in the sandbox.
- SBOM generation (CycloneDX + SPDX) as part of every white-box scan.
- License-compliance flag for corporate use.

---

### 16. IDE Extensions (VS Code, JetBrains)

**Gap.** Findings live in the terminal or the SaaS web app. Developers never see them at the point of writing code.

**Customer pain.** "Shift left" doesn't work when the feedback is 20 minutes away in CI.

**Done = **
- VS Code extension: inline diagnostics from a local scan, code-lens "Run Strix on this function", problems-panel integration.
- JetBrains plugin with parity.
- Both read from `strix_runs/` + can trigger a scoped scan.

---

## P2 — Platform Breadth & Polish

### 17. Autofix in the CLI (fix-it command)

**Gap.** The cloud platform advertises one-click autofix PRs, but there's no `strix fix` in the CLI. Users have to copy-paste the suggested remediation.

**Customer pain.** Closing the loop from finding → patch is the real value multiplier.

**Done = **
- `strix fix <run-name>` spawns a fix-oriented agent that proposes a git patch per finding.
- `--open-pr` flag uses `gh`/`glab`/`az repos` to raise the PR.
- Fixes are validated by re-running a tiny targeted scan on the patched code before submission.

---

### 18. Custom Report Templates & Export Formats

**Gap.** The non-interactive CLI prints a text panel; the TUI renders cards. Beyond that, there's no PDF, no branded HTML, no Markdown export, no JUnit XML, no CSV, no DOCX.

**Customer pain.** Security teams have to hand-craft client reports from JSON. Bug-bounty submitters want Markdown. Auditors want PDF.

**Done = **
- `strix report --format pdf|html|md|docx|junit|csv <run-name>` with customizable Jinja templates.
- Branded report mode (logo, company colors, cover page) for MSSPs.
- Parameterized filters (only Critical/High, only one compliance framework).

---

### 19. Local Web Dashboard

**Gap.** The TUI is terminal-only; the web UI lives on the SaaS (`app.strix.ai`). Local-only customers have no GUI.

**Customer pain.** Managers and non-terminal users can't consume results.

**Done = **
- `strix dashboard` serves a local Next.js app reading `strix_runs/`.
- Auth via a local token.
- Equivalent views to the TUI plus multi-run history, trends, compare.

---

### 20. Scheduled & Continuous Scanning

**Gap.** One-off CLI invocations only. No cron, no drift detection between runs.

**Customer pain.** Continuous-testing programs need a "scan nightly and tell me what's new" workflow.

**Done = **
- `strix schedule add --cron "0 2 * * *" --target …` on top of the worker queue (§10).
- Drift detection: only report findings that are new since the last successful scan.
- Slack/Teams/Email digests.

---

### 21. Mobile Application Testing (iOS / Android)

**Gap.** Strix is web- and code-oriented. No IPA/APK static analysis, no Frida/Objection instrumentation, no mobile network interception.

**Customer pain.** Mobile-first companies (fintech, consumer) need mobile coverage or they pay for a second tool.

**Done = **
- `mobile_android` and `mobile_ios` skill packs.
- Sandbox variant with Android emulator + `apktool`, `jadx`, `mobsf`, Frida gadget.
- Mobile-specific findings (hardcoded keys, unsafe `WebView`, insecure intent, keychain misuse).

---

### 22. Container Image & Kubernetes Manifest Scanning

**Gap.** Kubernetes skill exists for runtime testing; nothing scans image contents (Trivy-style) or cluster manifests (kube-bench, kubesec).

**Customer pain.** Container-first infra teams expect image CVE + manifest misconfig coverage.

**Done = **
- `strix --target oci://myregistry/myimage:tag` triages image layers.
- Kubernetes manifest static analysis skill (privilege escalation, host networking, missing seccomp/apparmor, etc.).

---

### 23. Diff Reports Between Scans

**Gap.** Findings are per-run. There's no "what changed since last Tuesday" view.

**Customer pain.** Security leaders care about trajectory, not absolute count.

**Done = **
- `strix diff <run-a> <run-b>` classifies findings as new / fixed / unchanged / regressed.
- Same payload available from the API.
- Scheduled scans produce these diffs automatically.

---

### 24. Air-Gapped / Offline Mode

**Gap.** The installer and sandbox both pull from the internet. Air-gapped environments (defense, manufacturing) can't install.

**Customer pain.** Large segment of government/defense/industrial prospects is unreachable.

**Done = **
- Offline bundle: binary + sandbox image + skill packs as a single signed archive.
- `strix install --offline ./strix-bundle.tar.gz`.
- Support private registries for the sandbox image.
- Support air-gapped local LLMs end-to-end (Ollama guide, hardware sizing).

---

## P3 — Enterprise Hardening & Operability

### 25. RBAC, SSO, Audit Log for Self-Hosted Deployments

**Gap.** The OSS CLI has no identity. Self-hosted enterprise rollouts need "who ran what, when, on which target, with which approval".

**Customer pain.** Compliance teams block any tool without a provable audit trail.

**Done = ** Server mode (§8) plus SAML/OIDC, scoped API keys, approval workflows for scans on production assets, immutable audit log (exportable to SIEM).

---

### 26. Prompt-Injection & Scope-Escape Defense

**Gap.** The agent reads attacker-controlled content (pages, APIs, source files). A crafted string could try to talk the agent into scanning an out-of-scope target or exfiltrating sandbox state.

**Customer pain.** Security teams evaluating a *security product* rightly ask: "how are you hardened against prompt injection?" There's no published story today.

**Done = **
- Strict scope enforcement at the runtime layer (not only at the prompt layer) — outbound firewall enforcing the authorized target set.
- Untrusted-content tagging so the LLM treats scraped data differently from instructions.
- Red-team regression tests with known jailbreak payloads.
- Published threat model.

---

### 27. Cost Governance & Budget Controls

**Gap.** LLM spend per scan is unpredictable. A runaway deep scan on a huge repo can silently burn hundreds of dollars.

**Customer pain.** Finance blocks rollouts without a hard ceiling.

**Done = **
- `--max-cost 10.00` and `--max-tokens` enforced across all agents in the graph.
- Per-agent telemetry of tokens/cost is already collected — surface budgets + alerts.
- Daily/weekly org budgets in worker mode.

---

### 28. Observability: Grafana Dashboards & Log Pipelines

**Gap.** OTEL/Traceloop export exists, but there are no reference dashboards. Customers have to build their own.

**Customer pain.** "Works out of the box with our Grafana" is a checkbox enterprise buyers tick.

**Done = **
- Canonical Grafana dashboard JSON (scan throughput, token cost, finding severity, failure rate).
- Datadog and New Relic equivalents.
- Log schema documented for ingest into Splunk / Elastic.

---

### 29. Benchmark & Regression Harness

**Gap.** [benchmarks/](https://github.com/usestrix/strix/tree/main/benchmarks) has a README but no published leaderboard or CI-run regression suite. No public claim like "Strix catches N% of CWE-XYZ on benchmark Z".

**Customer pain.** Buyers compare to Snyk/Veracode/Checkmarx on numbers. Without hard numbers we lose eval cycles.

**Done = **
- Expand benchmark set: OWASP Juice Shop, DVWA, WebGoat, RailsGoat, NodeGoat, custom micro-benchmarks per vuln class.
- CI runs benchmarks on every release; results published as a badge.
- Variance control (seed, deterministic temps) for reproducible scoring.

---

### 30. Alternative Container Runtimes (Podman, containerd, K8s Jobs)

**Gap.** `DockerRuntime` is hard-coded around the Docker daemon. Podman, Colima, Rancher Desktop, and pure `containerd` setups need shims.

**Customer pain.** Post-Docker-Desktop-licensing, many orgs have moved to Podman and get stuck on first launch.

**Done = **
- `PodmanRuntime` (drop-in; API-compatible with Docker).
- Driver detection at startup with clean errors.
- Rootless mode documented.

---

## P4 — Long-Horizon Differentiators

### 31. Fine-Tuned & Self-Hosted Model Guides

**Gap.** LiteLLM means any model works, but there's no published guide for fine-tuning on security traces, no evaluation methodology, no hardware sizing for open models.

**Done = **
- Reference fine-tune recipe (Llama 3.1 70B, Qwen 2.5) on Strix's agent-trace corpus.
- Published eval methodology so customers can compare their fine-tune.
- Hardware sizing (VRAM, TPS) for local deployments.

---

### 32. Knowledge Retention Across Scans (Org Memory)

**Gap.** Every scan starts from zero. A finding previously validated as a false positive is re-opened next run. Hard-won context about an app (routes, auth model, business logic) is thrown away.

**Done = **
- Per-target "org memory" store of validated facts, false positives, and auth contexts.
- Retrieved and injected into the next scan's system prompt.
- Expiry + versioning so stale memory doesn't mislead.

---

### 33. Attack Chain Visualization & Kill-Chain Graphs

**Gap.** The TUI shows the agent graph. It doesn't show the *attack chain* — how a low-severity info disclosure + a weak reset token + an IDOR combine into account takeover.

**Done = ** Chain aggregation in reporting: grouped findings + a graph view (in the dashboard §19) showing the exploit path.

---

### 34. Browser Extension for Manual Testers

**Gap.** Manual testers using Burp/Caido have no equivalent "ask Strix about this request" ergonomics.

**Done = ** Chrome/Firefox extension that pipes the current request into a focused Strix agent and shows annotated suggestions inline.

---

### 35. Red-Team Campaign Mode

**Gap.** Strix is tuned for point-in-time pentests. Adversary-emulation engagements (MITRE ATT&CK style, days-long, multiple phases) are not modelled.

**Done = **
- Campaign primitive with phases (recon → initial access → persistence → lateral → exfil).
- ATT&CK technique mapping on findings.
- Time-boxed pacing and human-in-the-loop approval gates.

---

## How to Read This Roadmap

- **Priority tiers are customer-impact, not engineering effort.** Some P0s (SARIF) are days; others (resumable scans) are weeks.
- **Each item should produce a visible change in [feature.md](feature.md).** When something ships, move it out of this file and document it there.
- **Skill-pack items (§7, §11, §12, §13) are parallelizable community work** — they're high priority precisely because they don't block on core engineering and directly expand coverage.
- **Nothing here is a commitment to build everything** — it's a map of the gaps. Sequence and scope should follow customer conversations and usage telemetry.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — what ships today.
- [feature.md](feature.md) — detailed breakdown of shipped features.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to pick something up.
- [docs.strix.ai](https://docs.strix.ai) — user-facing documentation.
