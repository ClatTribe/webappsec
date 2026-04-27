# User Inputs Reference

What the user has to provide to make each Strix workflow run — credentials, accounts, configurations, and CLI flags. Grouped by purpose so you can find what you need based on what you're testing.

> **TL;DR.** Strix's surface is intentionally minimal: one mandatory env var (`STRIX_LLM`), one CLI flag (`-t`), and Docker running. Everything else is conditional on (a) which LLM provider you use, (b) what kind of target you're testing, (c) whether the app needs authentication, and (d) whether you're testing cloud infrastructure.

---

## Table of Contents

1. [Always Required (every run)](#1-always-required-every-run)
2. [LLM Provider Auth](#2-llm-provider-auth)
3. [Target Access](#3-target-access)
4. [Authenticated App Testing](#4-authenticated-app-testing)
5. [Cloud Account Testing](#5-cloud-account-testing)
6. [Optional Features](#6-optional-features)
7. [CI / CD Integration](#7-cicd-integration)
8. [Multi-Target Combinations](#8-multi-target-combinations)
9. [Telemetry & Observability](#9-telemetry--observability)
10. [What You Can't Provide Today](#10-what-you-cant-provide-today)
11. [Quick Decision Tree](#11-quick-decision-tree)
12. [Worked Examples](#12-worked-examples)

---

## 1. Always Required (every run)

| Input | Source | Notes |
|---|---|---|
| **LLM model id** | `STRIX_LLM` env var | LiteLLM-compatible string, e.g. `openai/gpt-5.4`, `anthropic/claude-sonnet-4-6`. Persisted to `~/.strix/cli-config.json` after the first run. |
| **Target** | `-t/--target <value>` (repeatable) | URL, domain, IPv4, repo URL (`https://github.com/...` or `git@...`), or a local path. |
| **Docker** | running daemon on the host | First run pulls `ghcr.io/usestrix/strix-sandbox`. |

That's the baseline. Everything below is conditional.

---

## 2. LLM Provider Auth

Strix doesn't talk to the model directly — [LiteLLM](https://github.com/BerriAI/litellm) does. So whatever LiteLLM expects for your chosen provider is what you have to provide.

### Per-provider matrix

| Provider | Required env vars | Notes |
|---|---|---|
| **OpenAI** | `STRIX_LLM=openai/<model>`, `LLM_API_KEY=sk-…` | |
| **Anthropic** | `STRIX_LLM=anthropic/<model>`, `LLM_API_KEY=sk-ant-…` | Prompt caching enabled automatically when supported. |
| **Google Vertex AI** | `STRIX_LLM=vertex_ai/<model>`, `GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json` (or `gcloud auth application-default login`) | No `LLM_API_KEY` needed. Install the `vertex` extra: `pip install strix-agent[vertex]`. |
| **AWS Bedrock** | `STRIX_LLM=bedrock/<model>`, standard AWS creds (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` or a profile) | No `LLM_API_KEY` needed. |
| **Azure OpenAI** | `STRIX_LLM=azure/<deployment>`, `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION` | |
| **Local — Ollama** | `STRIX_LLM=ollama/<model>`, `LLM_API_BASE=http://localhost:11434` | No `LLM_API_KEY` needed (or any string). |
| **Local — LMStudio** | `STRIX_LLM=openai/<model>`, `LLM_API_BASE=http://localhost:1234/v1` | LMStudio exposes an OpenAI-compatible API. |
| **OpenRouter** | `STRIX_LLM=openrouter/<provider>/<model>`, `LLM_API_KEY=sk-or-…` | |
| **Strix-hosted** | `STRIX_LLM=strix/<model>`, `LLM_API_KEY=…` | API base auto-set to `https://models.strix.ai/api/v1`. |

### Important property

The LLM API key is sent to the provider as the HTTP `Authorization` header — it **never enters the conversation**. The model itself never sees the key text. See [data-flow.md §6](data-flow.md) for the full path.

### Switching providers

Provider env vars are tracked together (`Config._LLM_CANONICAL_NAMES`). Changing any LLM-related variable causes the whole LLM block in `~/.strix/cli-config.json` to be cleared and re-populated, so stale `OLLAMA_API_BASE` won't leak when you switch back to OpenAI.

---

## 3. Target Access

What you have to provide to make the target reachable.

### Local code (`-t ./my-app`)

- Path must exist on disk.
- Strix tar-streams a copy into `/workspace/<subdir>` inside the container — there's **no host bind-mount**, so edits inside the container don't write back to your tree.
- No additional auth.
- Useful for: white-box review of a checked-out repo, IaC analysis, frontend + backend as monorepo subdirs.

### GitHub / Git repository (`-t https://github.com/org/repo` or `git@github.com:org/repo.git`)

The repo is cloned on the **host** before the container starts (via a `git clone` subprocess). So the same git auth your user account already has applies:

| Repo visibility | Auth source |
|---|---|
| Public HTTPS | None |
| Private HTTPS | `gh auth login` token, `git credential` helper, `~/.netrc`, or `https://<token>@github.com/...` URL |
| SSH (`git@…`) | Your SSH agent / `~/.ssh/id_*` |
| Enterprise GitHub / GitLab / Bitbucket | Same options, pointed at your enterprise host |

If Strix can't clone, the run errors out before the container even starts — fix git auth first.

### Web application (`-t https://your-app.com`)

- Must be reachable from **inside the container** — public internet works without setup.
- For `localhost` / `127.0.0.1` URLs, Strix automatically rewrites to `host.docker.internal` so the sandbox can reach a dev server on your machine.
- No auth at the network level. App-level auth goes via `--instruction` (next section).

### Domain (`-t example.com`) / IP (`-t 192.168.1.42`)

- Must resolve / be routable from inside the container.
- For internal IPs, the container needs network access to that IP — typically a host VPN that the container reaches through `host.docker.internal`, or running Strix on a host inside the network.

---

## 4. Authenticated App Testing

To test behind a login, the agent has to know how to log in. Strix has **no built-in credential vault** — credentials reach the agent via the task description.

### Inline credentials

```bash
strix --target https://your-app.com \
      --instruction "Authenticate as user:pass and focus on IDOR vulnerabilities"
```

### Detailed rules of engagement (from a file)

```bash
strix --target https://your-app.com --instruction-file ./roe.md
```

A typical `roe.md`:

```markdown
# Rules of Engagement

## Test accounts
- admin:S0meL0ngPass — full admin
- user1:hunter2 — regular user, owns invoice 4912
- user2:hunter2 — regular user, owns invoice 4913 (use to test IDOR cross-tenant)

## Out of scope
- Do not exercise /webhooks/* — they fire real Slack notifications
- Do not test /admin/billing/charge
- Rate-limit any payload spray to <50 rps

## API
- Base URL: https://api.your-app.com
- API keys are JWT, valid for 1h. Get one via POST /auth/login with the test creds above.

## Focus
- IDOR on /api/invoices/{id}
- Privilege escalation between user→admin
- JWT signature handling
```

### How those credentials reach the tools

1. Instruction text becomes part of the **first user message** to the root agent.
2. The agent types those credentials into `terminal_execute` / `python_action` / `browser_action` calls itself.
3. Credentials cross the host→sandbox HTTPS boundary as part of those tool kwargs.
4. They land in `events.jsonl` and the conversation history (the telemetry sanitizer in [`strix/telemetry/utils.py`](https://github.com/usestrix/strix/blob/main/strix/telemetry/utils.py) scrubs known token shapes — generic passwords aren't redacted automatically).

### MFA / SSO

Not natively supported today. Practical notes:

- The agent can drive a Playwright browser through some SSO flows — but the prompt has to tell it the exact steps.
- TOTP codes have to be provided in the instruction (e.g. "use TOTP secret `JBSW…`"). The agent can compute the current code via `python_action`.
- WebAuthn / passkeys / hardware keys: out of reach.
- Recorded login replay is tracked in [roadmap.md §4](roadmap.md).

---

## 5. Cloud Account Testing

This is the area with the **biggest gap** between what users reasonably expect and what Strix natively supports today.

### What works out of the box

- **Kubernetes cluster testing** — there's a `cloud/kubernetes` skill, and the agent can run `kubectl` from `terminal_execute` if a kubeconfig is present in the workspace. Pass it as a local source target:

  ```bash
  strix --target ./infra-repo --instruction-file ./k8s-roe.md
  # roe.md mentions kubeconfig path inside /workspace/infra-repo/
  ```

- **Container image / IaC repo scanning** — `Trivy` is preinstalled in the sandbox, so a repo with `terraform/`, `Dockerfile`, `k8s/*.yaml` works as a local-code target and gets analyzed by an agent that loads the right skills.

### What you have to wire yourself

For AWS, Azure, GCP, Cloudflare, etc. there is **no first-class credential injection**. The container does **not** inherit your host env vars — the env set in [`_create_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) is fixed:

```python
environment={
    "PYTHONUNBUFFERED": "1",
    "TOOL_SERVER_PORT": str(CONTAINER_TOOL_SERVER_PORT),
    "TOOL_SERVER_TOKEN": self._tool_server_token,
    "STRIX_SANDBOX_EXECUTION_TIMEOUT": str(execution_timeout),
    "HOST_GATEWAY": HOST_GATEWAY_HOSTNAME,
}
```

So your `AWS_ACCESS_KEY_ID` doesn't automatically reach the agent.

Practical workarounds, from simplest to safest:

#### Option A — pass via instruction (simplest, but creds end up in events.jsonl)

```bash
strix --target my-app.com --instruction \
  "Test against AWS account 1234. Use these test creds:
   AWS_ACCESS_KEY_ID=AKIA…, AWS_SECRET_ACCESS_KEY=…, region=us-east-1.
   Stay within the IAM role 'strix-pentest' which only has read perms."
```

The agent will then `export AWS_ACCESS_KEY_ID=…` inside `terminal_execute` and run `aws cli` / `aws-vault` / boto3 calls.

#### Option B — drop a profile/config file in a local-code target

```bash
mkdir cloud-test
cp ~/.aws/credentials cloud-test/.aws-creds
strix --target ./cloud-test --target https://my-app.com \
      --instruction-file ./cloud-roe.md
```

The instruction tells the agent to `export AWS_SHARED_CREDENTIALS_FILE=/workspace/cloud-test/.aws-creds`. Slightly safer because the secret never goes through the LLM context as a credential string — only as a file path.

#### Option C — build a custom sandbox image (not recommended)

`STRIX_IMAGE=my-image:tag` lets you bake `aws configure` data into the image, but that's now a static credential in your image — bad hygiene.

### Strongly recommended hygiene

- Provision a **scoped, time-limited IAM role / service principal** for Strix.
- Pre-flight test that the role can only read what you want it to.
- Rotate credentials after the run.
- Tell the agent in the instruction *exactly* which actions are out of scope ("never call `s3:DeleteObject`, never call `iam:Create*`"). The agent will respect this — but it's not enforced at the AWS API level.

### What's missing (tracked in roadmap)

- Native cloud-provider skill packs beyond Kubernetes — [roadmap.md §11](roadmap.md): `aws_iam`, `aws_s3`, `aws_lambda`, `aws_rds`, `aws_cognito`, `azure_entra`, `azure_storage`, `gcp_iam`, `gcp_gcs`, `terraform`, `cloudformation`.
- Vault integration for secrets — [roadmap.md §14](roadmap.md): HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, 1Password Connect, Doppler.
- Session recording for cloud SSO logins — [roadmap.md §4](roadmap.md).
- A built-in read-only IAM role pattern with a scope policy.

---

## 6. Optional Features

| Feature | Input | Effect |
|---|---|---|
| **Web search** for fresh CVE / payload data | `PERPLEXITY_API_KEY=pplx-…` | Registers the `web_search` tool |
| **Reasoning effort** (cost / quality knob) | `STRIX_REASONING_EFFORT=high` (or `none`/`minimal`/`low`/`medium`/`high`/`xhigh`) | Default `high`; `quick` scan auto-selects `medium` |
| **Disable browser** (smaller memory footprint) | `STRIX_DISABLE_BROWSER=true` | Skips `browser_*` tool registration |
| **Custom sandbox image** | `STRIX_IMAGE=your-registry/strix-sandbox:tag` | Use your own pre-built image |
| **Per-tool execution timeout** | `STRIX_SANDBOX_EXECUTION_TIMEOUT=300` | Default 120 s |
| **Local-model API base** | `LLM_API_BASE=http://localhost:11434` | For Ollama / LMStudio etc. |
| **Custom config file** | `--config ./pentest.json` | Overrides `~/.strix/cli-config.json` for this run only; not persisted back |
| **Scan mode** | `-m quick` / `standard` / `deep` (default) | Controls phase depth and agent fan-out |
| **Scope mode** | `--scope-mode auto` / `diff` / `full` | PR-diff scoping for code targets |
| **Diff base** | `--diff-base origin/main` | Explicit base when auto-detection fails |

---

## 7. CI / CD Integration

For PR-scoped scans in CI you typically need:

| Input | Why |
|---|---|
| `actions/checkout@v6` with `fetch-depth: 0` | So Strix can resolve the diff against the base branch |
| `STRIX_LLM` and `LLM_API_KEY` as repository secrets | Provider auth |
| `--scope-mode diff` (or `auto` in CI) | Limit the scan to changed files |
| `--diff-base origin/main` | Explicit base if auto-detection fails |
| `-n` / `--non-interactive` | Required for CI (no TUI) |

A typical workflow (also in [Strix README](https://github.com/usestrix/strix#readme)):

```yaml
name: strix-penetration-test

on:
  pull_request:

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Install Strix
        run: curl -sSL https://strix.ai/install | bash

      - name: Run Strix
        env:
          STRIX_LLM: ${{ secrets.STRIX_LLM }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
        run: strix -n -t ./ --scan-mode quick
```

### Exit code semantics

- `0` — scan completed, no vulnerabilities found.
- `2` — scan completed, **vulnerabilities were found** (use this for merge gating).
- Other non-zero — Docker / LLM / config failure, user interrupt, or unhandled exception.

GitLab CI, Jenkins, CircleCI, Azure DevOps, Bitbucket — same pattern, just translate the workflow syntax. Built-in templates for those are tracked in [roadmap.md §3](roadmap.md).

---

## 8. Multi-Target Combinations

Many real workflows combine targets. Common patterns:

| Goal | Targets to pass |
|---|---|
| **White-box review of a deployed service** | `-t https://github.com/org/app -t https://staging.example.com` |
| **Multi-repo monorepo split** | `-t ./services/auth -t ./services/payments -t ./services/admin` |
| **Frontend + backend as separate repos** | `-t https://github.com/org/web -t https://github.com/org/api -t https://app.example.com` |
| **API + cloud infra repo** | `-t https://api.example.com -t ./terraform-infra` |
| **Local checkout + production endpoint** | `-t ./my-app -t https://my-app.com` |

The agent automatically cross-correlates: source insights guide dynamic testing; dynamic anomalies prioritize code review. Each code target is mounted to its own `/workspace/<subdir>` so they stay separated inside the container.

---

## 9. Telemetry & Observability

| Input | Effect |
|---|---|
| `STRIX_TELEMETRY=0` | Master kill switch — disables PostHog and OTEL exports. Local `events.jsonl` is always written. |
| `STRIX_POSTHOG_TELEMETRY=0` | Disable PostHog only. |
| `STRIX_OTEL_TELEMETRY=1` | Enable OpenTelemetry / Traceloop export. |
| `TRACELOOP_API_KEY` | Traceloop ingest token. |
| `TRACELOOP_BASE_URL` | Traceloop endpoint (custom collector OK). |
| `TRACELOOP_HEADERS` | Comma-separated headers for OTEL exporter. |

The local event log is always written to `strix_runs/<run-name>/events.jsonl` regardless of telemetry settings — the kill switch only affects external exports.

Sensitive values (Bearer tokens, API keys, screenshots) are scrubbed by [`TelemetrySanitizer`](https://github.com/usestrix/strix/blob/main/strix/telemetry/utils.py) before any telemetry leaves the host. See [data-flow.md §10](data-flow.md) for the redaction model.

---

## 10. What You Can't Provide Today

Worth knowing up-front so you're not looking for it.

| Want | Status |
|---|---|
| HashiCorp Vault / 1Password / AWS SM credential references | Not supported. [roadmap.md §14](roadmap.md). |
| Recorded SSO / WebAuthn login replay | Not supported. [roadmap.md §4](roadmap.md). |
| Findings suppression / `.strixignore` baseline | Not supported. [roadmap.md §5](roadmap.md). |
| AWS / Azure / GCP first-class skill packs | Only Kubernetes today. [roadmap.md §11](roadmap.md). |
| Slack / Jira / Linear integration for findings | Not in OSS — available on the SaaS platform. |
| GitHub PR comments / inline annotations from the CLI | Not supported. [roadmap.md §1](roadmap.md). |
| Auto-resume of a crashed scan | Not supported. [roadmap.md §6](roadmap.md). |
| Per-scan cost cap (`--max-cost`) | Not supported. [roadmap.md §27](roadmap.md). |
| Mobile app testing (IPA / APK) | Not supported. [roadmap.md §21](roadmap.md). |
| Inheriting host env vars into the sandbox | Intentional design — you must explicitly pass values via `--instruction` or workspace files. |

---

## 11. Quick Decision Tree

```
What are you testing?
│
├─ A web app I run                        → -t https://your-app.com
│   └─ Behind login? → add --instruction "user:pass" or --instruction-file
│
├─ A repo on GitHub                       → -t https://github.com/org/repo
│   └─ Private? → ensure git auth on host (gh auth / SSH key)
│
├─ Local source tree                      → -t ./path
│
├─ A whole org's infra                    → -t multiple repos + URLs
│
├─ Kubernetes cluster                     → -t ./infra-repo (with kubeconfig inside)
│                                            + --instruction "use kubeconfig at /workspace/..."
│
├─ AWS / Azure / GCP                      → -t app-url
│                                            + --instruction with creds + IAM scope
│                                            + (optional) -t ./iac-repo
│
└─ A PR diff in CI                        → -t ./ -m quick --scope-mode diff
                                             + fetch-depth: 0
                                             + STRIX_LLM, LLM_API_KEY as secrets
```

The **minimum** is `STRIX_LLM`, `LLM_API_KEY`, Docker, and one `-t`. Everything else is layered on as the workflow demands it.

---

## 12. Worked Examples

Concrete, copy-pasteable invocations for common scenarios.

### A. Black-box scan of a public domain

```bash
export STRIX_LLM="anthropic/claude-sonnet-4-6"
export LLM_API_KEY="sk-ant-…"
strix --target https://example.com
```

### B. White-box scan of a private GitHub repo

```bash
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="sk-…"
gh auth login                              # or set GITHUB_TOKEN
strix --target https://github.com/myorg/api
```

### C. Authenticated grey-box test of a staging app

```bash
strix --target https://staging.myapp.com \
      --instruction-file ./roe.md
```

Where `roe.md` contains test accounts, scope, focus areas.

### D. White-box of source + dynamic test of running app

```bash
strix --target ./backend \
      --target http://localhost:8080 \
      --instruction "App is running locally on port 8080. Test creds: dev:dev123"
```

### E. CI quick scan on PR

```yaml
# .github/workflows/strix.yml
on: pull_request
jobs:
  strix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - run: curl -sSL https://strix.ai/install | bash
      - env:
          STRIX_LLM: ${{ secrets.STRIX_LLM }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
        run: strix -n -t ./ -m quick --scope-mode diff
```

### F. Local model (Ollama) for an offline scan

```bash
ollama pull llama3.1:70b
export STRIX_LLM="ollama/llama3.1:70b"
export LLM_API_BASE="http://localhost:11434"
strix --target ./my-app
```

### G. Cloud-aware scan with AWS read-only role

```bash
# Stage credentials
mkdir cloud-test
cat > cloud-test/.aws-config <<EOF
[profile strix-readonly]
aws_access_key_id=AKIA…
aws_secret_access_key=…
region=us-east-1
EOF

# Stage RoE
cat > roe.md <<EOF
Test the deployed app at https://api.example.com.
For AWS testing, use AWS_SHARED_CREDENTIALS_FILE=/workspace/cloud-test/.aws-config
and AWS_PROFILE=strix-readonly.
The role only has Get*/List*/Describe* — never attempt write operations.
Out of scope: any iam:* calls except iam:Get*/iam:List*.
EOF

strix --target ./cloud-test \
      --target https://api.example.com \
      --instruction-file ./roe.md
```

### H. Multi-target audit of a microservices monorepo

```bash
strix --target ./services/auth \
      --target ./services/payments \
      --target ./services/admin \
      --target https://staging.example.com \
      --scan-mode deep \
      --instruction "Cross-correlate: auth issues in code → privilege checks at https://staging.example.com"
```

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — install, build, architecture overview.
- [feature.md](feature.md) — every shipped feature in detail.
- [data-flow.md](data-flow.md) — where each input is stored and how it reaches tools.
- [Isolation.md](Isolation.md) — what each boundary actually enforces.
- [orchestration-logic.md](orchestration-logic.md) — how the agent uses your inputs to plan a scan.
- [roadmap.md](roadmap.md) — the gaps called out in §10 above.
- [docs.strix.ai](https://docs.strix.ai) — public user-facing documentation.
