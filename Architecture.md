# Architecture

This document describes how `webappsec` is wired together — how scans are isolated across users and parallel runs, how user identity and integration credentials are handled, and what gaps remain before the system is broadly useful to customers.

For the design rationale and historical alternatives considered, see [`docs/webapp-supabase-design.md`](docs/webapp-supabase-design.md). For the Strix engine internals that the wrapper invokes, see [`docs/multiagent.md`](docs/multiagent.md) and [`docs/Isolation.md`](docs/Isolation.md).

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Scan handling — multi-user, parallel, isolated](#2-scan-handling--multi-user-parallel-isolated)
3. [User and integration data handling](#3-user-and-integration-data-handling)
4. [Roadmap](#4-roadmap)

---

## 1. System overview

Three independently deployable tiers. Each holds a different kind of state, communicates through a narrow interface, and can be replaced in isolation.

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
└──────┬─────────────────────────────────────┬─────────────────────┘
       │ HTTPS                               │ Realtime channel
       ▼                                     ▼
┌──────────────────────────────┐    ┌────────────────────────────────┐
│ Vercel (Next.js 14)          │    │ Supabase Realtime               │
│ - Auth UI, dashboard         │    │ Postgres LISTEN/NOTIFY          │
│ - Scan + integrations UI     │    │ broadcast filtered by RLS       │
│ - API routes (server-only)   │    │                                 │
└──────┬─────────────────────┬─┘    └──────────┬─────────────────────┘
       │ supabase-js (anon)  │                 │ scan:<id>
       ▼                     ▼                 │
┌──────────────────────────────────────────────┴─────────────────────┐
│                         Supabase                                    │
│ - Postgres + RLS (every tenant table org_id-keyed)                  │
│ - Auth (email, OAuth, MFA, magic link)                              │
│ - Vault (pgsodium-encrypted integration secrets)                    │
│ - Storage (artifacts, kubeconfigs, ROE files)                       │
│ - Realtime (LISTEN/NOTIFY broadcast over WebSocket)                 │
└────────────────────────────────────────────┬───────────────────────┘
                                             │ pg_notify('scan_queued', new.id)
                                             ▼
                              ┌─────────────────────────────────┐
                              │ Worker (Fly.io)                  │
                              │ - LISTEN scan_queued             │
                              │ - Decrypt integration creds      │
                              │ - Spawn: strix -n -t … …         │
                              │ - Stream events back via RPC     │
                              │ - Upload artifacts to Storage    │
                              └────────┬────────────────────────┘
                                       │ docker run
                                       ▼
                              ┌─────────────────────────────────┐
                              │ Strix sandbox                    │
                              │ ghcr.io/usestrix/strix-sandbox   │
                              └─────────────────────────────────┘
```

| Tier | Hosted on | Owns |
|---|---|---|
| **Frontend** | Vercel | UI, OAuth callbacks, server API routes |
| **Data plane** | Supabase | Identity, RLS-enforced DB, vault, storage, realtime |
| **Compute** | Fly.io (or any Docker host) | Worker process that runs Strix subprocesses |

Strix itself runs as a one-shot subprocess inside the worker — no long-lived agent, no shared state across scans. The contract between the worker and Strix is just CLI flags + env vars + the on-disk `<cwd>/strix_runs/<run>/` tree, exactly as a human would invoke it.

---

## 2. Scan handling — multi-user, parallel, isolated

### 2.1 Lifecycle of one scan

```
User clicks "Start scan"
       │
       │ POST /api/scans  { targets, scan_mode, integration_ids, instruction_text }
       │ Cookie carries Supabase JWT (with org_id claim)
       ▼
[Frontend API route — frontend/app/api/scans/route.ts]
   1. supabase.auth.getUser()                         verifies session
   2. Zod-validate body
   3. Read org_id from JWT
   4. INSERT INTO scans (status='queued')             ← RLS check
   5. INSERT INTO scan_targets                        ← RLS check
   6. INSERT INTO scan_integrations                   ← RLS check
   7. admin.from('audit_log').insert(...)             ← service-role bypass
   8. Return { scan_id }
       │
       │ Postgres trigger:
       │   pg_notify('scan_queued', new.id::text)
       ▼
[Worker — worker/src/strix_worker/listener.py]
   asyncio.create_task(self._dispatch(scan_id))       ← bounded by Semaphore
       │
       ▼
[Worker — worker/src/strix_worker/runner.py:run_scan]
   1. fetch_scan(scan_id)                             status check
   2. start_scan(scan_id)                             RPC: scans.status='running'
   3. materialize_credentials(...)                    decrypt + env/files
   4. _resolve_llm                                    per-scan > per-org > worker default
   5. asyncio.create_subprocess_exec(strix, ...)      spawn Strix
   6. while running:
        for line in stdout/stderr:
          worker_insert_scan_event(scan_id, 'log', …) ← service-role RPC
   7. on exit:
        _upload_run_artifacts(...)                    every file → scan-artifacts bucket
        _ingest_finding(vuln-*.md) per file           parsed → findings table
        worker_finish_scan(scan_id, status, ...)      finalize + emit scan.finished
   8. CredentialBundle.cleanup()                      env wipe + temp file unlink
       │
       │ Every worker_insert_* RPC inserts into a Realtime-enabled table
       ▼
[Browser — components/scan/scan-live-view.tsx]
   .channel(`scan:${scanId}`).on('postgres_changes', …)
```

### 2.2 Concurrency model

Two axes of parallelism:

**Within one worker process.** Each `scan_queued` notification spawns its own `asyncio.create_task`, gated by `asyncio.Semaphore(WORKER_CONCURRENCY)` ([listener.py:26](webapp/worker/src/strix_worker/listener.py:26)). Default is 1 because Strix's `Config`, `_agent_graph`, and `Tracer` are process-global; raising the limit only becomes safe once Strix's per-scan-state refactor lands. Each scan gets its own `asyncio.Task` → its own subprocess (own PID, own env dict, own stdout pipe) → its own Strix sandbox container.

**Across worker processes.** Horizontal scale just runs more workers. Each opens its own `LISTEN scan_queued` connection. Postgres broadcasts the NOTIFY to every listener, so two workers may try to claim the same scan; the race is resolved by `worker_start_scan`'s `WHERE status='queued'` clause ([20260427000005_worker_rpcs.sql:50](webapp/supabase/migrations/20260427000005_worker_rpcs.sql:50)) — only the first UPDATE finds the row in `queued` state, so the second one's update affects 0 rows. The losing worker proceeds to spawn Strix anyway, which is a real bug — see [§4.1](#41-critical-fixes-needed-before-shipping).

A startup sweep (`_sweep_pending` at [listener.py:65](webapp/worker/src/strix_worker/listener.py:65)) picks up scans that were notified while the worker was down.

### 2.3 Five isolation boundaries

Each layer addresses one class of attacker / fault.

| Layer | Threat model | Mechanism |
|---|---|---|
| **Run ↔ Run** | One scan corrupting another's state | Strix-native: per-scan Docker container with a fresh 256-bit auth token + per-scan tmp workdir (`/tmp/strix-runs/<scan_id>/`) on the worker side |
| **Agent ↔ Agent** within a scan | Sub-agents stomping on each other's terminals/browsers | Strix-native: per-agent ContextVar routes terminal panes / IPython kernels / browser tabs |
| **Sandbox ↔ Worker** | Compromised target escaping the agent container | Standard Docker boundary; worker mounts host `docker.sock` to spawn the sandbox |
| **Worker ↔ DB** | Stolen service-role key dumping all secrets | Service-role + security-definer RPCs that re-verify org consistency before reading vault rows ([20260427000003_vault_helpers.sql:65-79](webapp/supabase/migrations/20260427000003_vault_helpers.sql:65)) |
| **Org ↔ Org** | Tenant A reading tenant B's scans/findings/credentials | RLS on every tenant-scoped table keyed on `auth.jwt() ->> 'org_id'`; the JWT hook injects `org_id` into the token ([20260427000002_jwt_hook.sql](webapp/supabase/migrations/20260427000002_jwt_hook.sql)) |

The **org boundary** is the new one this wrapper adds; the four below it inherit from Strix.

### 2.4 What protects parallel cross-tenant runs

If two organizations queue scans simultaneously and both land on the same worker:

1. Each scan has its own `asyncio.Task`, subprocess, env dict, and tmp dir.
2. Credentials decrypted for scan A live only in scan A's `CredentialBundle.env` dict ([credentials.py:29-31](webapp/worker/src/strix_worker/credentials.py:29)). Scan B's subprocess inherits its own env from `{**os.environ, **scan_b.env}` ([runner.py:66](webapp/worker/src/strix_worker/runner.py:66)) — there's no shared env state.
3. Every worker→DB RPC carries `scan_id`. The security-definer functions look up `scans.org_id` from that ID and use it for the insert ([20260427000005_worker_rpcs.sql:22-28](webapp/supabase/migrations/20260427000005_worker_rpcs.sql:22)). A scan can only ever write events/findings into its own org.
4. Realtime broadcast is filtered by RLS — clients subscribed to scan A's events get nothing from scan B.

**Where the wall is thin.** The worker process itself is shared. A sandbox-escape in scan A's container puts the attacker on the same host as scan B's container. Phase 3 of the [roadmap](#43-enterprise) replaces the host-`docker.sock` model with one Kubernetes Job per scan to eliminate this.

---

## 3. User and integration data handling

### 3.1 Identity

The Supabase Auth user table (`auth.users`) is authoritative. `public.profiles` extends it with `full_name` and `avatar_url`, auto-created on signup via a trigger ([20260427000000_init_schema.sql:184-195](webapp/supabase/migrations/20260427000000_init_schema.sql:184)). Auth methods supported today:

- Email + password (with optional confirmation)
- TOTP MFA (opt-in per user; not enforced for admins yet)
- Magic link
- OAuth providers (Google, GitHub) — wire on demand in `supabase/config.toml`

### 3.2 Multi-org membership and roles

A user belongs to N organizations via `org_members(user_id, org_id, role)`. Roles in priority order: `owner > admin > member > viewer`. Capability matrix:

| Action | viewer | member | admin | owner |
|---|---|---|---|---|
| Read scans/findings | ✓ | ✓ | ✓ | ✓ |
| Create scans | – | ✓ | ✓ | ✓ |
| Triage findings | – | ✓ | ✓ | ✓ |
| Add/remove integrations | – | ✓ | ✓ | ✓ |
| Revoke integrations | – | – | ✓ | ✓ |
| Add/remove org members | – | – | ✓ | ✓ |
| Update org settings (LLM key, plan) | – | – | – | ✓ |
| Read audit log | – | – | ✓ | ✓ |

Capabilities are enforced at the SQL layer in [20260427000001_rls_policies.sql](webapp/supabase/migrations/20260427000001_rls_policies.sql) — there is no role-checking middleware in the API; if you try to delete an integration as a viewer, RLS returns "0 rows affected" and the route returns 403.

### 3.3 The `org_id` JWT claim

Every authenticated request reads `auth.jwt() ->> 'org_id'`. The claim is injected by `custom_access_token_hook` ([jwt_hook.sql](webapp/supabase/migrations/20260427000002_jwt_hook.sql)), which:

1. Honors a client-supplied `org_id` if the user is a member of that org (this is how org-switching works).
2. Otherwise defaults to the user's oldest membership.
3. Also injects `org_role` so RLS policies can do role checks without an extra join.

**Important.** Tenant context comes from the JWT, not from cookies or URL params. The frontend never derives `org_id` from anywhere else — it's read out of `session.access_token`'s payload in API routes ([api/scans/route.ts:36-40](webapp/frontend/app/api/scans/route.ts:36)).

### 3.4 Integration secrets — encryption at rest

User-provided credentials (GitHub tokens, AWS role ARNs, kubeconfigs, etc.) are the most sensitive data in the system. They live in three places:

```
Frontend integration form  ──► /api/integrations  (Zod-validated)
                                       │
                                       │ admin.rpc('vault_create_secret', {...})
                                       ▼
                          ┌────────────────────────────┐
                          │ vault.secrets               │
                          │ pgsodium-encrypted at rest  │
                          │ never queried directly      │
                          └────────────┬───────────────┘
                                       │ vault_secret_id pointer
                                       ▼
                          ┌────────────────────────────┐
                          │ public.integrations         │
                          │ org_id, type, metadata,     │
                          │ vault_secret_id, status     │
                          │ RLS-protected, org-scoped   │
                          └─────────────────────────────┘
```

**Plaintext is never stored on `public.integrations`.** The row carries only:
- `org_id` — for RLS
- `type` — `github`, `aws`, etc.
- `metadata` — non-secret hints (GitHub login, AWS role ARN, region)
- `vault_secret_id` — UUID pointer
- `status` — `active` / `revoked` / `expired`

Even the user who created the secret cannot read it back. The frontend has no read endpoint that returns plaintext. There is exactly one path to the bytes: the worker calls `worker_decrypt_integration` at scan time.

### 3.5 Decrypt-at-scan-time path

[`worker_decrypt_integration(scan_id, integration_id)`](webapp/supabase/migrations/20260427000003_vault_helpers.sql:40) is a `security definer` Postgres function that:

1. Verifies `integrations.org_id == scans.org_id`.
2. Verifies a `scan_integrations` link exists — the scan must explicitly authorize this integration (defence in depth: even if a scan_id is hijacked, only its linked integrations are decryptable).
3. Inserts an `audit_log` row with `action='integration.use'`.
4. Bumps `integrations.last_used_at`.
5. Returns the plaintext from `vault.decrypted_secrets`.

The RPC is gated on `auth.role() = 'service_role'`, so it can only be called with the service-role key (which lives only in the worker and the frontend's server-side admin client, never in browser code).

### 3.6 Per-source materialization

Once decrypted, each integration type is translated into the env vars / files Strix's tools expect ([credentials.py:93-156](webapp/worker/src/strix_worker/credentials.py:93)):

| Type | What's stored in vault | Materialized as |
|---|---|---|
| **GitHub** | `{access_token, refresh_token}` | `GITHUB_TOKEN` env |
| **GitLab** | `{access_token}` | `GITLAB_TOKEN` env |
| **AWS** | `{role_arn, external_id, region}` | At scan time: `sts:AssumeRole` (1-hour duration) → `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN/DEFAULT_REGION`. Falls back to long-lived keys if no role ARN. |
| **Azure** | `{client_id, client_secret, tenant_id}` | `AZURE_CLIENT_ID/SECRET/TENANT_ID` env |
| **GCP** | `{service_account_json}` | Mode-0600 temp file + `GOOGLE_APPLICATION_CREDENTIALS` path |
| **Kubernetes** | `{kubeconfig}` (raw text) | Mode-0600 temp file + `KUBECONFIG` path |
| **Webhook** | `{url, signing_secret}` | Worker-only (not passed to agent) |

[`CredentialBundle`](webapp/worker/src/strix_worker/credentials.py:26) is a context manager. Whatever happens — the scan succeeds, Strix crashes, the worker is OOM-killed mid-scan — the `finally` branch unlinks every temp file (`Path.unlink(missing_ok=True)`) and clears the env dict. Plaintext lives in worker memory only between `materialize_credentials.__enter__` and `__exit__`.

### 3.7 What the LLM never sees

| Credential | Status |
|---|---|
| User's `LLM_API_KEY` | Never in prompt context — it's the HTTP `Authorization` header on outbound requests |
| Other orgs' integration credentials | RPC enforces `integration.org_id == scan.org_id` |
| Supabase service-role key | Server-only env var, never sent to browser or sandbox |
| Worker→Supabase Bearer token | Same |

What the LLM **does** see:

- Anything the user puts in `instruction_text` (test passwords, ROE).
- Anything the agent learns from the target itself.
- Plaintext of any credential the worker put in `os.environ` — required, since `terminal_execute` invokes `aws cli`, `kubectl`, `git`, etc., and those tools read from env. There is no realistic way to give Strix's terminal tool access to a credential without making it readable by the agent.

---

## 4. Roadmap

Items below are scoped to make `webappsec` (the wrapper) genuinely useful to paying customers. They are **separate from** [docs/roadmap.md](docs/roadmap.md), which tracks improvements to Strix itself.

### 4.1 Critical fixes needed before shipping

These are bugs and gaps in the existing code that will surface immediately under real usage.

| # | Fix | Why it matters | Where |
|---|---|---|---|
| 1 | **Fix the severity parser.** `line.split(":", 1)[1]` splits inside `**Severity:**` and produces `"** high"`, which fails the DB check constraint and gets silently swallowed by the broad `except`. Findings are silently dropped. | Findings never appear in the UI. | [runner.py:238](webapp/worker/src/strix_worker/runner.py:238) |
| 1a | **Fix exit-code-2 mishandling.** The original `if exit_code in (0, 2): final_status = "completed"` conflates Strix success with argparse usage errors. A scan submitted with no `-t` exits 2 and was silently marked "completed" with zero findings. **Fixed in this PR:** `exit_code == 0` only counts as completed. | Bad scans showed up as successful. | [runner.py:78](webapp/worker/src/strix_worker/runner.py:78) |
| 2 | **Use the structured fields.** The `findings` schema has columns for CVSS, CWE, target, endpoint, method, PoC — currently only `description_md` is populated. Parse the rest from the rich Strix markdown. | Severity-sorted lists, compliance reporting, and PoC display all need structured data. | [runner.py:225-252](webapp/worker/src/strix_worker/runner.py:225) |
| 3 | **Stream `events.jsonl` live**, not just at end. Today the live UI shows raw stdout strings; the structured agent graph only appears after exit. | Users stare at a near-blank screen for 5–30 minutes. | [runner.py:165-190](webapp/worker/src/strix_worker/runner.py:165) — needs Strix-side event-sink callback (Phase-0 Strix change) |
| 4 | **Populate token / cost stats.** `worker_finish_scan` is called with all zeros for `total_input_tokens / output_tokens / cost / agents_count`. Parse them from `events.jsonl` after exit. | Billing, cost caps, per-org quotas all depend on these. | [supabase_client.py:46-50](webapp/worker/src/strix_worker/supabase_client.py:46) |
| 5 | **Scan-cancel button.** No way to stop a runaway scan today. The user pays for every token. | Cost overruns; user trust. | New: `POST /api/scans/[id]/cancel` → `worker_cancel_scan` RPC → SIGTERM the subprocess. |
| 6 | **Atomic claim, not racy LISTEN.** Two workers can both try to claim the same scan; the loser still spawns Strix because the existing race check at [runner.py:36-38](webapp/worker/src/strix_worker/runner.py:36) reads stale data. | Duplicate scans, doubled cost. | Replace LISTEN-then-update with `SELECT FOR UPDATE SKIP LOCKED` over a `scans` view, or add a `claimed_by` column updated atomically before `start_scan`. |
| 7 | **MFA enforcement for admins/owners.** Today MFA is opt-in. | An admin password compromise unlocks the whole org's secrets. | Add a check in middleware + an enrolment-required redirect for users with role in (`owner`, `admin`) and no `aal2`. |
| 8 | **Audit-log UI.** The data is captured; no page renders it. | SOC 2 / ISO 27001 readiness. | New: `app/(app)/audit-log/page.tsx`. |
| 9 | **Email notification on scan complete.** | Users don't keep the tab open for hour-long scans. | New: Postgres trigger on `scans` UPDATE → Edge Function → Resend / SES. |

### 4.2 Production readiness

For revenue beyond the closed beta.

| # | Feature | Why |
|---|---|---|
| 10 | **Per-org cost caps on LLM spend.** Block new scan creation when month-to-date `sum(scans.total_cost)` exceeds the org's plan limit. | Prevents one runaway scan from generating a six-figure invoice. |
| 11 | **Per-org concurrency + daily quotas.** `WHERE org_id` count check before insert. | Fair-share across customers on the shared worker pool. |
| 12 | **Egress firewall in the sandbox.** Pin iptables ALLOW to authorized targets (resolve hostnames at scan start, allow only those IPs/ports) at sandbox-container entry. | Prevents prompt-injection-driven exfiltration to attacker-controlled endpoints. |
| 13 | **SARIF export of findings.** GitHub Code Scanning, GitLab Security Dashboard, and most enterprise SIEMs ingest SARIF. | Without this, security teams can't put findings into their existing workflow. |
| 14 | **Compliance mapping on findings.** Auto-tag CWE → OWASP Top 10 / PCI / SOC 2 / ISO 27001. Filter findings page by tag. | Regulated customers can't justify a tool that doesn't speak their compliance language. |
| 15 | **Webhook notifications.** Generic webhook + Slack + PagerDuty templates on `finding.created` (severity ≥ high) and `scan.failed`. | Plug into existing incident-response loops. |
| 16 | **Worker autoscaling.** Fly machines scale from 1 → N based on `scans` queue depth (queued+running rows per worker). | Predictable scan latency under burst load. |
| 17 | **GitLab / Azure / GCP integration UIs.** Stubs exist at [integrations/new/[type]/page.tsx](webapp/frontend/app/(app)/integrations/new/[type]/page.tsx) but are not implemented. | Half the cloud market is unserved today. |
| 18 | **Cancel-on-budget-exceeded.** Auto-SIGTERM scans that exceed the org's per-scan cost cap, with a `scan.cancelled.over_budget` event. | Backstop for #10. |
| 19 | **PR-comment integration.** GitHub App that comments findings on the relevant PR. | The number-one reason teams adopt SAST. |

### 4.3 Enterprise

For ARR > $100K customers — features that are dealbreakers for procurement.

| # | Feature | Why |
|---|---|---|
| 20 | **SSO / SAML.** Okta, Azure AD, Google Workspace. Auto-provision membership from groups. | Required by most companies > 200 employees. |
| 21 | **Custom roles + fine-grained RBAC.** Today the four roles are hard-coded. Enterprise wants "can run scans on prod-aws but not stage-aws". | Required for least-privilege procurement. |
| 22 | **K8s-Job-per-scan compute model.** Replace host-`docker.sock` mount with a per-scan ephemeral Job (`activeDeadlineSeconds`, network policies, no shared filesystem). | Containment of a sandbox-escape from "the whole worker" to "just that scan". |
| 23 | **Self-hosted air-gapped deployment.** Helm chart, no outbound calls during scan, on-prem LLM (Ollama / Bedrock private endpoint). | Government, defence, regulated-industry customers. |
| 24 | **REST API + scoped API tokens.** `api_tokens` table exists ([init_schema.sql:168](webapp/supabase/migrations/20260427000000_init_schema.sql:168)) but no API surface uses it. | CI/CD integration: trigger scans from Jenkins, push findings into Jira. |
| 25 | **Per-org LLM provider keys via Vault.** Schema supports it (`organizations.llm_api_key_secret_id`); UI doesn't. | Customers want to use their own OpenAI/Anthropic accounts and bills. |
| 26 | **Cross-scan finding deduplication.** The `fingerprint` column exists; nothing uses it. Group same-vuln-found-twice across runs. | Triage burden — without dedup, every weekly scan re-creates 200 known-issue rows. |
| 27 | **Suppression / triage workflow improvements.** Bulk triage, time-bound suppressions, expirable false positives. | Reduces alert fatigue at scale. |
| 28 | **Audit-log retention policy + export.** Today rows live forever; SOC 2 requires retention controls. Add archive-to-S3 for rows older than `org.plan.retention_days`. | Compliance. |

### 4.4 Strix-side prerequisites

Some of the above need Strix to expose APIs the wrapper can use. Tracked in [docs/roadmap.md](docs/roadmap.md), but the high-leverage ones for this wrapper are:

- **Event-sink callback** — POST every event to a worker-local URL (or directly to Supabase). Unblocks #3 (live event stream), #4 (token stats), #18 (cost-based cancel).
- **Structured `create_vulnerability_report` event** — emit a JSON event alongside the markdown so the wrapper doesn't have to parse `**ID:**`/`**Severity:**` headers. Unblocks #2.
- **Scan-scoped state** — replace process-global `Config / _agent_graph / Tracer` with per-scan instances. Unblocks raising `WORKER_CONCURRENCY` from 1, which is the most cost-effective scaling lever today.
- **Cancel signal handling** — make Strix shut down gracefully on SIGTERM (close subagents, flush events, exit). Unblocks #5.

---

### 4.5 Findings from a real white-box scan against this repo

Scan #6 (Gemini 2.5 Pro, `quick` mode) found 5 issues before the LLM hit the free-tier RPD cap and stalled. Three of them were genuinely new and not in the §4.1 list above:

| # | Severity | Finding | Status in this PR |
|---|---|---|---|
| F1 | **HIGH** (CVSS 8.5) | **SSRF in `inferTargetType`** — accepts `http://127.0.0.1`, `http://169.254.169.254`, `http://10.x` etc. as `web_application` targets, letting an authenticated user point Strix at the worker's internal network | **Fixed** — `isInternalAddress` rejects loopback / RFC1918 / link-local / IPv6 ULA / cloud-metadata hosts at the API boundary. DNS rebinding still gets through; egress firewall (#12) closes that gap |
| F2 | **MEDIUM** (CVSS 4.9) | **Audit gap in `worker_decrypt_org_llm_key`** — the LLM-key decrypt RPC writes no audit_log row and silently produces "org has no LLM API key configured" when the scan_id is bogus, while its sibling `worker_decrypt_integration` does both | **Fixed** — new migration `20260427000008` brings the two functions to parity |
| F3 | **MEDIUM** (CVSS 5.3) | Email confirmation off in `config.toml` | Intentional dev-only setting; the `# set true in production` comment makes the intent explicit. Not changed |
| F4 | **CRITICAL** (CVSS 9.8) | "Outdated frontend dependencies" — Next 14.2.5, etc. | Won't fix in this PR — npm audit's CVSS scores often overstate actual impact for transitive deps; tracked under §4.1 #1 dependency hygiene |
| F5 | **HIGH** (CVSS 8.2) | "Hardcoded `postgres:postgres` in `.env.example`" | False-positive — these are local Supabase defaults, not real credentials |

Also surfaced while wiring up the run:
- **JWT-hook function had two real bugs** — local variable `user_id` shadowed the column (every signup 500'd with `column reference "user_id" is ambiguous`), and the function wasn't `SECURITY DEFINER` so it couldn't read `org_members` as `supabase_auth_admin`. **Fixed** in `20260427000007_fix_jwt_hook_variable_shadow.sql`.
- **Worker dockerization on macOS is fundamentally limited.** Strix's `_resolve_docker_host()` returns `127.0.0.1` from inside the worker container, but the spawned sandbox is on the host's docker daemon — they can't reach each other. Production deploy on a privileged Linux machine works fine; macOS Docker Desktop without TCP API exposure does not. The right fix is the [§4.3 #22 K8s-Job-per-scan model](#43-enterprise); the temporary workaround is to run the worker on the host directly (kept the `docker-compose.yml` for Linux deployments).

---

## See also

- [`README.md`](README.md) — Quick start, repo layout, top-level overview.
- [`webapp/README.md`](webapp/README.md) — End-to-end setup and reference for the implementation.
- [`docs/Isolation.md`](docs/Isolation.md) — Isolation guarantees Strix already enforces (this wrapper builds on them).
- [`docs/webapp-supabase-design.md`](docs/webapp-supabase-design.md) — Design rationale, alternatives considered, phased rollout.
- [`docs/data-flow.md`](docs/data-flow.md) — Data flow for the standalone Strix CLI (analogue to §2.1).
- [`docs/roadmap.md`](docs/roadmap.md) — Strix engine roadmap (separate from the wrapper roadmap above).
