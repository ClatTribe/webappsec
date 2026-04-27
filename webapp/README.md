# Strix Web App

Multi-tenant SaaS wrapper around the Strix security agent. Users sign up, connect their GitHub / AWS / Kubernetes / etc. accounts, and run scans through a web UI. Findings stream in live. Each organization's data, runs, credentials, and reports are isolated end-to-end.

This folder is **independent** from the rest of the Strix repo. The worker invokes the `strix` CLI as a subprocess, so the agent code (which lives in [`../strix/`](../strix)) never has to know it's running inside a SaaS.

> **TL;DR.** Three pieces — Next.js on Vercel, Postgres + Auth + Vault on Supabase, Python worker on Fly.io — talking to the unmodified Strix CLI. Multi-tenant isolation is enforced at the database layer (Row-Level Security on every table, JWT-injected `org_id` claim) and at the credential layer (Vault-encrypted integration secrets decrypted only at scan time inside the worker process).

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [How It Connects to Strix](#2-how-it-connects-to-strix)
3. [Features](#3-features)
4. [Repository Layout](#4-repository-layout)
5. [Prerequisites](#5-prerequisites)
6. [Local Development](#6-local-development)
7. [Production Deployment](#7-production-deployment)
8. [Build](#8-build)
9. [Configuration & Environment Variables](#9-configuration--environment-variables)
10. [Data Flow](#10-data-flow)
11. [Security Model](#11-security-model)
12. [Roadmap](#12-roadmap)
13. [Troubleshooting](#13-troubleshooting)
14. [See Also](#14-see-also)

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                           Browser                                  │
└──────┬───────────────────────────────────┬─────────────────────────┘
       │ HTTPS                             │ Realtime channel
       ▼                                   ▼
┌──────────────────────────────┐    ┌────────────────────────────────┐
│   Vercel (Next.js)           │    │  Supabase Realtime             │
│   - Auth UI, dashboard       │    │  Postgres LISTEN/NOTIFY +      │
│   - Scan UI, integrations    │    │  broadcast channels            │
│   - API routes (server)      │    │                                │
└──────┬─────────────────────┬─┘    └──────────┬─────────────────────┘
       │                     │                 │
       │ supabase-js         │                 │ subscribes to
       │ (anon + RLS)        │                 │ scan:<id>
       ▼                     │                 │
┌──────────────────────────────────────────────┴─────────────────────┐
│                          Supabase                                   │
│   - Postgres + RLS (users, orgs, scans, findings, audit, …)        │
│   - Auth (email, OAuth, MFA, magic link)                           │
│   - Storage (artifacts, kubeconfigs, ROE files)                    │
│   - Vault / pgsodium (encrypted integration credentials)           │
│   - Realtime (LISTEN/NOTIFY broadcast)                             │
└────────────────────────────────────────────┬───────────────────────┘
                                             │
                                             │ pg_notify('scan_queued', new.id)
                                             │ when a row is inserted in 'queued' state
                                             ▼
                              ┌─────────────────────────────────┐
                              │   Worker (Fly.io)               │
                              │                                 │
                              │   - Subscribes to scan_queued   │
                              │   - Decrypts integration creds  │
                              │     via security-definer RPC    │
                              │   - Spawns: strix -n -t … --instruction …
                              │   - Streams events back via     │
                              │     worker_insert_scan_event RPC│
                              │   - Uploads artifacts to        │
                              │     Supabase Storage            │
                              └────────┬────────────────────────┘
                                       │ docker run
                                       ▼
                              ┌─────────────────────────────────┐
                              │  Strix sandbox container        │
                              │  ghcr.io/usestrix/strix-sandbox │
                              │  (existing image, unchanged)    │
                              └─────────────────────────────────┘
```

Three runtime tiers, each independently deployable:

| Tier | Hosted on | What it owns |
|---|---|---|
| **Frontend** | Vercel | Auth UI, dashboard, scan UI, integration setup, OAuth callbacks, API routes |
| **Data plane** | Supabase | Identity, database (RLS-enforced), credential vault, file storage, real-time event broadcast |
| **Compute** | Fly.io (or any host with Docker) | Worker process that picks queued scans and runs Strix |

The Strix engine itself runs as a one-shot subprocess inside the worker — no long-lived agent processes, no shared state across scans, no special server mode required from Strix.

---

## 2. How It Connects to Strix

The web app **wraps** the existing Strix CLI rather than calling Strix as a library. This was a deliberate choice — it lets us use any released version of `strix-agent` without forking, and the process boundary doubles as a fault isolation barrier.

### The contract

The worker invokes Strix exactly the way a human would on the command line:

```bash
strix -n \
  -m <quick|standard|deep> \
  --scope-mode <auto|diff|full> \
  -t <target1> [-t <target2> ...] \
  --instruction "<text>"
```

Plus environment variables:

| Env var | Source | Purpose |
|---|---|---|
| `STRIX_LLM` | Per-org or worker default | LiteLLM model id (e.g. `openai/gpt-5.4`) |
| `LLM_API_KEY` | Per-org Vault or worker default | Provider API key (decrypted just-in-time) |
| `GITHUB_TOKEN` | Per-scan, from connected GitHub integration | Used by `git clone` for private repos |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | Per-scan, short-lived from `sts:AssumeRole` | Cloud testing |
| `KUBECONFIG` | Per-scan, points at a temp file the worker writes | K8s testing |
| `GOOGLE_APPLICATION_CREDENTIALS` | Per-scan, points at a temp file | GCP testing |
| `STRIX_PERSIST_CONFIG=false` | Always | Prevents Strix from writing `~/.strix/cli-config.json` in a shared worker home |

### What flows back

- Strix writes scan artifacts to `<cwd>/strix_runs/<run-name>/` inside the worker (the worker sets `cwd` to a per-scan temp directory).
- The worker tails Strix's stdout/stderr → forwards as `log` events to Supabase via the `worker_insert_scan_event` RPC.
- On exit, the worker scans the run dir for vulnerability markdown files and ingests them into the `findings` table via `worker_insert_finding`.
- Final markdown reports are uploaded to Supabase Storage at `<org_id>/<scan_id>/`.

### What's not yet ideal

This integration is intentionally simple but has rough edges:

1. **Coarse log streaming.** We forward stdout lines as one event each. The Strix tracer's structured `events.jsonl` is uploaded only at the end. A future change to Strix should add an event-sink callback (POST every event to a worker-local URL or directly to Supabase) so the live UI renders agent graphs and tool calls in real time, not just stdout text.
2. **Markdown-parse for findings.** Findings come back as Strix-generated `.md` files which we parse with a coarse heuristic. A structured JSON event from Strix's `create_vulnerability_report` tool would be cleaner.
3. **Process-per-scan only.** The worker runs `WORKER_CONCURRENCY` parallel subprocesses, but each subprocess is a separate Strix invocation. We don't pack multiple scans into one Strix process because Strix's `Config`, `_agent_graph`, and `Tracer` are process-global. This is fine for early stages and can be revisited when the per-scan-state refactor lands upstream in Strix.

These are tracked in [../docs/webapp-supabase-design.md §8](../docs/webapp-supabase-design.md) as Phase 0/1 work on the Strix side.

---

## 3. Features

### Authentication & accounts
- Email/password sign-in and signup (via Supabase Auth).
- Multi-factor authentication (TOTP) — built-in, opt-in per user.
- Magic link sign-in.
- OAuth login providers (Google, GitHub) — wire on demand in `supabase/config.toml`.
- Per-user profile, multi-organization membership.
- Custom JWT claim injecting the active `org_id` into every authenticated request.

### Organizations & roles
- Each user belongs to one or more organizations.
- Roles: `owner`, `admin`, `member`, `viewer`.
- Per-role capabilities enforced at the SQL layer (Row-Level Security policies).
- Audit log of every role change, integration use, scan start.

### Integrations
First-class connection flows for the credentials Strix needs to access targets:

| Integration | Auth flow | Credential storage |
|---|---|---|
| **GitHub** | OAuth App (`/api/integrations/oauth/github/start` → `…/callback`) | Access + refresh token in Vault |
| **GitLab** | OAuth (same shape) | Token in Vault |
| **AWS** | IAM Role + External ID — paste the role ARN | ARN + external ID in Vault; worker calls `sts:AssumeRole` for short-lived creds |
| **Azure** | Service principal credentials form | Client ID / secret / tenant in Vault |
| **GCP** | Service account JSON upload | JSON in Vault; written to a temp file at scan time |
| **Kubernetes** | Kubeconfig paste | Kubeconfig text in Vault; written to a temp file at scan time |
| **Webhook** | URL + signing secret | URL + secret in Vault |

Every integration use is logged to the `audit_log` table.

### Scans
- Multi-target scan creation (any combination of repos, web apps, domains, IPs, local paths).
- Three scan modes (`quick`, `standard`, `deep`) and three scope modes (`auto`, `diff`, `full`) — exactly mirrors the Strix CLI flags.
- Per-scan integration selection: pick which credentials Strix is authorized to use.
- Free-form instruction box for ROE / credentials / focus areas.
- Live agent graph and event stream via Supabase Realtime.
- Findings appear in the UI as soon as the agent commits them, severity-color-coded.
- Per-scan exit code, LLM token usage, total cost rolled up in the scan row.
- Scan history, filterable.

### Findings
- Cross-scan findings list, sortable by severity.
- Triage workflow: open / triaged real / false positive / wont fix / fixed.
- Markdown content with PoC, CVSS, technical analysis, remediation.
- Per-finding file-location data for white-box scans.
- Stable fingerprint for cross-scan dedup.

### Real-time UX
- Postgres `LISTEN/NOTIFY` + Supabase Realtime stream every scan event to the browser.
- RLS guarantees only the right org's clients can subscribe to a given scan.
- No custom WebSocket server required.

### Audit log
- Every integration creation, integration use (decrypt), scan start, role change.
- Visible to org admins under `/audit-log` (TODO page; data is captured today).
- Required for SOC 2 / ISO 27001.

### Operational features
- Postgres trigger fires `pg_notify('scan_queued', …)` on insert so the worker wakes immediately.
- Worker re-sweeps queued scans on startup so nothing is lost across restarts.
- Bounded scan concurrency per worker (`WORKER_CONCURRENCY`).
- Best-effort credential cleanup (env wipe, temp-file unlink) on every scan exit, success or failure.

---

## 4. Repository Layout

```
webapp/
├── README.md                         this file
│
├── supabase/                         data plane
│   ├── README.md
│   ├── config.toml                   local-dev project config (buckets, ports, auth)
│   ├── seed.sql                      demo org seeder
│   └── migrations/
│       ├── 20260427000000_init_schema.sql       11 tables + auto-profile-on-signup trigger
│       ├── 20260427000001_rls_policies.sql      RLS on every tenant table + storage policies
│       ├── 20260427000002_jwt_hook.sql          custom_access_token_hook injects org_id claim
│       ├── 20260427000003_vault_helpers.sql     vault_create_secret + worker_decrypt_*
│       ├── 20260427000004_pg_notify_trigger.sql wakes worker on scan_queued
│       ├── 20260427000005_worker_rpcs.sql       insert event / start scan / finish scan / insert finding
│       └── 20260427000006_realtime.sql          publishes scan_events + findings + scans to Realtime
│
├── frontend/                         Next.js 14 app for Vercel
│   ├── README.md
│   ├── package.json, tsconfig.json, next.config.js, tailwind.config.ts
│   ├── .env.local.example
│   ├── middleware.ts                 session refresh + auth gate on protected routes
│   ├── lib/
│   │   ├── oauth.ts                  signed OAuth state tokens (CSRF)
│   │   └── supabase/
│   │       ├── client.ts             browser client (anon, RLS-bound)
│   │       ├── server.ts             server-component client (cookie-bound)
│   │       ├── admin.ts              service-role client (server-only)
│   │       └── types.ts              DB types
│   ├── app/
│   │   ├── layout.tsx, globals.css, page.tsx
│   │   ├── login/, signup/
│   │   ├── (app)/                    auth-required shell
│   │   │   ├── layout.tsx            sidebar nav + auth gate
│   │   │   ├── dashboard/, scans/, scans/new/, scans/[id]/
│   │   │   ├── findings/
│   │   │   ├── integrations/, integrations/new/[type]/, integrations/[id]/
│   │   │   ├── team/, settings/
│   │   └── api/
│   │       ├── auth/signout/
│   │       ├── orgs/                 POST: create org during signup
│   │       ├── scans/                POST: queue a scan
│   │       └── integrations/
│   │           ├── route.ts          POST: AWS/K8s/etc. integrations
│   │           ├── [id]/             DELETE: revoke
│   │           └── oauth/github/
│   │               ├── start/        starts OAuth handshake with signed state
│   │               └── callback/     verifies state, exchanges code, persists encrypted token
│   └── components/scan/
│       └── scan-live-view.tsx        Realtime subscription (events + findings)
│
└── worker/                           compute plane
    ├── README.md
    ├── pyproject.toml                Python deps (supabase, psycopg, boto3, ...)
    ├── Dockerfile                    image with Strix + docker CLI + worker code
    ├── fly.toml                      Fly.io deployment config
    ├── .env.example
    ├── src/strix_worker/
    │   ├── __init__.py, __main__.py  entrypoint (strix-worker)
    │   ├── config.py                 env-based config validation
    │   ├── supabase_client.py        service-role wrapper (RPC + storage helpers)
    │   ├── credentials.py            decrypt + materialize (env vars, temp files)
    │   ├── runner.py                 spawn Strix subprocess + stream events
    │   └── listener.py               LISTEN/NOTIFY loop with bounded concurrency
    └── tests/test_credentials.py
```

---

## 5. Prerequisites

| Tool | Why | Where |
|---|---|---|
| **Node.js 20+** | Frontend dev | https://nodejs.org |
| **Python 3.12+** | Worker dev | https://python.org |
| **Docker Desktop** (running) | Local Supabase + Strix sandbox | https://docker.com |
| **Supabase CLI** | Local DB + migrations | `brew install supabase/tap/supabase` |
| **uv** | Python deps | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **strix-agent** (Python pkg) | The agent the worker spawns | `pipx install strix-agent` |
| **flyctl** (production only) | Worker deployment | `brew install flyctl` |
| **Vercel CLI** (production only) | Frontend deployment | `npm i -g vercel` |
| **GitHub OAuth App** (optional) | GitHub *integration* flow | https://github.com/settings/developers |

You also need an **LLM provider API key** (OpenAI, Anthropic, Google, AWS Bedrock, or local Ollama) — see [../docs/user-inputs.md §2](../docs/user-inputs.md) for the full provider matrix.

---

## 6. Local Development

End-to-end setup in 5 minutes.

### Step 1 — Database (Supabase local)

```bash
cd webapp/supabase
supabase init        # only the very first time (creates supabase/.gitignore etc.)
supabase start       # spins up local Postgres + Auth + Storage + Realtime in Docker
supabase db reset    # applies all 7 migrations from scratch
```

`supabase start` prints local URLs and keys — copy them. The relevant ones:

```
API URL:                http://localhost:54321
anon key:               eyJhbGciOi…
service_role key:       eyJhbGciOi…
DB URL:                 postgresql://postgres:postgres@localhost:54322/postgres
Studio URL:             http://localhost:54323
Inbucket (email):       http://localhost:54324
```

Open Studio (http://localhost:54323) to browse the schema and verify migrations applied.

**Enable the JWT hook** (one-time, only required to get `org_id` into the JWT):
- Studio → Authentication → Hooks → Add hook → Custom Access Token → select `public.custom_access_token_hook`.
- Or in `supabase/config.toml` set:
  ```toml
  [auth.hook.custom_access_token]
  enabled = true
  uri = "pg-functions://postgres/public/custom_access_token_hook"
  ```
  then `supabase stop && supabase start`.

### Step 2 — Frontend

```bash
cd webapp/frontend
cp .env.local.example .env.local
```

Edit `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste anon key from supabase start>
SUPABASE_SERVICE_ROLE_KEY=<paste service_role key>
OAUTH_STATE_SECRET=$(openssl rand -hex 32)
# GitHub OAuth — optional for first run; needed for the GitHub integration flow.
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Then:

```bash
npm install
npm run dev
# → http://localhost:3000
```

Sign up at `/signup`, create an org, you'll land on `/dashboard`.

### Step 3 — Worker

In a new terminal:

```bash
cd webapp/worker
cp .env.example .env
```

Edit `.env`:

```bash
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=<paste service_role key>
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres
STRIX_LLM=openai/gpt-5.4
LLM_API_KEY=<your key>
```

Make sure Strix is installed:

```bash
pipx install strix-agent
# or: uv tool install strix-agent
```

Then run the worker:

```bash
uv sync
uv run strix-worker
```

You should see:

```
INFO strix_worker starting worker (concurrency=1)
INFO strix_worker.listener listening for scan_queued notifications
```

### Step 4 — Run an end-to-end scan

In the browser at http://localhost:3000:

1. Go to **New Scan**.
2. Enter a target (e.g. `https://github.com/some/public-repo`).
3. Pick scan mode `quick`.
4. Click **Start scan**.

You should be redirected to the live scan view. The worker terminal will log:

```
INFO strix_worker.runner picking up scan <uuid>
INFO strix_worker.runner running: strix -n -m quick -t https://github.com/...
```

Live events stream into the UI as Strix runs. When the scan exits, findings appear in the right column and the status flips to `completed`.

### Useful local-dev commands

```bash
# Reset the database from scratch (drops all data, re-runs migrations)
cd webapp/supabase && supabase db reset

# Inspect the local database
psql postgresql://postgres:postgres@localhost:54322/postgres

# Tail worker logs in real time
cd webapp/worker && uv run strix-worker

# Frontend type-check + lint
cd webapp/frontend && npm run typecheck && npm run lint

# Worker tests
cd webapp/worker && uv run pytest
```

---

## 7. Production Deployment

| Tier | Where | How |
|---|---|---|
| Frontend | Vercel | `vercel deploy --prod` (after `vercel link`) |
| Database / Auth / Vault / Storage / Realtime | Supabase Cloud | `supabase link --project-ref <ref> && supabase db push` |
| Worker | Fly.io (or any Docker host) | `flyctl launch` then `flyctl deploy` |
| Sandbox image | GitHub Container Registry | Pulled by worker on first scan; can be self-hosted |

### Frontend on Vercel

```bash
cd webapp/frontend
vercel link
# Set env vars in the Vercel dashboard (Project → Settings → Environment Variables):
#   NEXT_PUBLIC_SUPABASE_URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY    (encrypted, server-only — DO NOT expose to client)
#   GITHUB_CLIENT_ID
#   GITHUB_CLIENT_SECRET
#   OAUTH_STATE_SECRET
#   NEXT_PUBLIC_SITE_URL=https://your-app.vercel.app
vercel deploy --prod
```

### Database on Supabase Cloud

```bash
cd webapp/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

After `db push`, in the Supabase dashboard:
1. **Authentication → Hooks → Custom Access Token** → select `public.custom_access_token_hook`.
2. **Authentication → Providers** → enable Email + any OAuth providers you want for *login*.
3. **Database → Replication → supabase_realtime publication** → confirm `scan_events`, `findings`, `scans` are listed.

### Worker on Fly.io

```bash
cd webapp/worker
flyctl launch --no-deploy
flyctl secrets set \
  SUPABASE_URL=https://<project>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<key> \
  SUPABASE_DB_URL='postgres://postgres:<pwd>@db.<project>.supabase.co:5432/postgres' \
  STRIX_LLM=openai/gpt-5.4 \
  LLM_API_KEY=<key>
# Privileged machine — required for Docker-in-Docker so Strix can spawn its sandbox.
flyctl machine update --privileged <machine-id>
flyctl deploy
```

For other hosts (Railway, Render, EC2, ECS, k8s) — same image, same env vars, just a Docker daemon mounted in.

### Sandbox image (optional self-host)

By default the worker pulls `ghcr.io/usestrix/strix-sandbox:0.1.13`. To self-host:

```bash
docker pull ghcr.io/usestrix/strix-sandbox:0.1.13
docker tag ghcr.io/usestrix/strix-sandbox:0.1.13 your-registry/strix-sandbox:0.1.13
docker push your-registry/strix-sandbox:0.1.13
flyctl secrets set STRIX_IMAGE=your-registry/strix-sandbox:0.1.13
```

Useful for air-gapped deployments and large enterprises with their own image policy.

---

## 8. Build

### Frontend

```bash
cd webapp/frontend
npm run build         # next build (static + serverless functions output)
npm run start         # serve the built app locally
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
```

Vercel runs `npm run build` automatically.

### Worker

```bash
cd webapp/worker

# Local sync of dependencies
uv sync

# Build the Docker image (also what fly deploy does)
docker build -t strix-worker:local .

# Run image locally
docker run --rm \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  strix-worker:local
```

The worker Dockerfile:
1. Starts from `python:3.12-slim`.
2. Installs `docker.io` (the CLI; we mount the host socket).
3. Installs `uv` and the Strix CLI from PyPI (`pip install strix-agent`).
4. Installs the worker package itself (`uv pip install -e .`).
5. Runs `strix-worker` as the entrypoint.

### Database migrations

Migrations are versioned SQL files under `supabase/migrations/`. The Supabase CLI applies them in order:

```bash
cd webapp/supabase
supabase db reset          # local — drops + reapplies all
supabase db push           # cloud — applies new ones to the linked project
supabase migration new <name>   # scaffold a new migration
```

---

## 9. Configuration & Environment Variables

Master list of every env var, where it's used, and what to set it to.

### Frontend (Vercel)

| Variable | Required | Where used | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | client + server | Public — exposed to browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | client + server | Public — RLS-bound |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | server-only API routes | **Encrypted server-only** — never sent to browser |
| `OAUTH_STATE_SECRET` | yes | server | HMAC secret for CSRF state tokens. Generate: `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` | for GitHub integration | server | From your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | for GitHub integration | server | Same |
| `NEXT_PUBLIC_SITE_URL` | yes (prod) | client + server | e.g. `https://strix.your-domain.com` — used for OAuth redirect URIs |

### Worker (Fly.io)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | https://<project>.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role — bypasses RLS via the worker RPCs |
| `SUPABASE_DB_URL` | yes | Direct Postgres conn string for `LISTEN/NOTIFY` |
| `STRIX_LLM` | yes (or per-org) | Default LiteLLM model id; per-org overrides via `organizations.llm_provider` |
| `LLM_API_KEY` | yes (or per-org) | Default LLM key; per-org keys via Vault take precedence |
| `STRIX_IMAGE` | no | Default `ghcr.io/usestrix/strix-sandbox:0.1.13` |
| `STRIX_BIN` | no | Default `strix` (must be on `$PATH`) |
| `WORKER_CONCURRENCY` | no | Default `1`; raise after Strix scan-scoped state refactor |
| `LOG_LEVEL` | no | `DEBUG`, `INFO` (default), `WARNING`, `ERROR` |

### Supabase

Configured in the Supabase dashboard rather than env vars. Make sure to enable:

- The `custom_access_token_hook` (Authentication → Hooks).
- Email auth (Authentication → Providers → Email).
- The `supabase_realtime` publication includes `scan_events`, `findings`, `scans`.
- Storage buckets `scan-artifacts` and `user-uploads` exist (created by `config.toml`).

### Local-dev quick fill

```bash
# Frontend
cat > webapp/frontend/.env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase start>
SUPABASE_SERVICE_ROLE_KEY=<from supabase start>
OAUTH_STATE_SECRET=$(openssl rand -hex 32)
EOF

# Worker
cat > webapp/worker/.env <<EOF
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase start>
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres
STRIX_LLM=openai/gpt-5.4
LLM_API_KEY=<your key>
EOF
```

---

## 10. Data Flow

```
┌──────────────┐
│ User in UI   │
│ "Start scan" │
└──────┬───────┘
       │ POST /api/scans
       │ { targets, scan_mode, integration_ids, instruction_text }
       │ Cookie carries Supabase JWT (with org_id claim)
       ▼
┌──────────────────────────────────────────────────────────────┐
│ /api/scans/route.ts  (server, anon-key client)               │
│   1. supabase.auth.getUser() — verifies session              │
│   2. Validate body with zod                                  │
│   3. Read org_id from JWT claim                              │
│   4. INSERT INTO scans (status=queued)         ← RLS check   │
│   5. INSERT INTO scan_targets                  ← RLS check   │
│   6. INSERT INTO scan_integrations             ← RLS check   │
│   7. admin.from('audit_log').insert(...)       ← service-role│
│   8. Return { scan_id }                                       │
└──────┬───────────────────────────────────────────────────────┘
       │ Postgres trigger:
       │   pg_notify('scan_queued', new.id::text)
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Worker (LISTEN scan_queued)                                  │
│   1. fetch_scan(scan_id)                                     │
│   2. worker_decrypt_org_llm_key(scan_id)   ← service-role RPC│
│   3. for each linked integration:                            │
│        worker_decrypt_integration(scan_id, int_id)           │
│        → org check, scan-link check, audit, plaintext        │
│   4. materialize creds: env vars + temp files                │
│   5. start_scan(scan_id) — worker_start_scan RPC             │
│   6. spawn: strix -n -t … --instruction …                    │
│   7. while running:                                          │
│        for each stdout/stderr line:                          │
│          worker_insert_scan_event(scan_id, 'log', {...})     │
│   8. on exit:                                                │
│        upload artifacts to scan-artifacts bucket             │
│        ingest vuln-*.md as findings via worker_insert_finding│
│        worker_finish_scan(scan_id, status, exit_code, ...)   │
│   9. cleanup: unlink temp files, clear creds                 │
└──────┬───────────────────────────────────────────────────────┘
       │ Every worker_insert_* RPC inserts into a Realtime-enabled table
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Supabase Realtime broadcast to subscribed clients            │
│ (filtered by RLS — only org members see)                     │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ ScanLiveView component (browser)                             │
│   .channel(`scan:${scanId}`)                                  │
│   .on('postgres_changes', {table: 'scan_events', ...})        │
│   .on('postgres_changes', {table: 'findings', ...})           │
│   .on('postgres_changes', {table: 'scans', event: 'UPDATE'})  │
│ Updates UI state as events arrive.                           │
└──────────────────────────────────────────────────────────────┘
```

For the analogue of this on the standalone Strix CLI, see [../docs/data-flow.md](../docs/data-flow.md).

---

## 11. Security Model

The web app inherits Strix's existing isolation guarantees ([../docs/Isolation.md](../docs/Isolation.md)) and adds a **fifth boundary**: org-↔-org isolation.

### Five layers of isolation

| Layer | Mechanism |
|---|---|
| **Run ↔ Run** | Strix-native: each scan gets its own Docker container with a fresh 256-bit auth token |
| **Agent ↔ Agent** within a scan | Strix-native: per-agent ContextVar routes terminal panes / IPython kernels / browser tabs |
| **Sandbox ↔ Worker** | Standard Docker boundary; worker mounts host docker.sock to spawn the sandbox image |
| **Worker ↔ DB** | Service-role key + security-definer RPCs that enforce org consistency |
| **Org ↔ Org** | Postgres RLS on every tenant-scoped table, keyed on `auth.jwt() ->> 'org_id'` |

### Where credentials live

```
User connects integration
        │
        │ secret_payload JSON
        ▼
vault_create_secret(secret, name, description)         ← service-role only
        │ pgsodium-encrypted
        ▼
vault.secrets table                                    ← never queried directly
        │
        │ vault_secret_id pointer
        ▼
public.integrations row                                ← RLS-protected, org-scoped

At scan time:
        │
        ▼
worker_decrypt_integration(scan_id, integration_id)    ← security definer
   1. verifies integration.org_id = scan.org_id
   2. verifies scan_integrations link exists
   3. inserts audit_log row
   4. returns plaintext from vault.decrypted_secrets
        │
        ▼
Worker process memory                                  ← only place plaintext lives
        │
        │ env vars + temp files (mode 0600)
        ▼
Strix subprocess
        │
        │ scan exits
        ▼
CredentialBundle.cleanup()                             ← env wipe + temp file unlink
```

### What the LLM never sees

- The user's `LLM_API_KEY` (sent as the HTTP `Authorization` header to the provider, not in `messages`).
- Anyone else's integration credentials (RPC enforces org/scan match).
- The Supabase service-role key.
- The worker-↔-Supabase Bearer token.

### What the LLM does see

- Anything the user puts in `--instruction` (e.g. test passwords). These end up in `events.jsonl` as part of the scan transcript.
- Anything the agent learns from the target itself.
- The plaintext of any credential the worker put in env (via `os.environ` reads from the agent's tools — necessary, since `terminal_execute` needs to be able to use `aws cli`, `kubectl`, `git`, etc.).

### Known gaps

| Gap | Mitigation path |
|---|---|
| Sandbox can reach arbitrary internet egress (prompt-injection exfil risk) | Add iptables-allowlist firewall in sandbox entrypoint based on authorized targets — Phase 1 in [../docs/webapp-supabase-design.md](../docs/webapp-supabase-design.md) |
| Worker mounts host Docker socket (sandbox-escape blast radius is the whole worker) | Move to per-scan Kubernetes Job in Phase 3, or use Fargate-style ephemeral compute |
| Service-role key has full DB blast radius | Already wrapped in security-definer RPCs; rotate via Vercel env var rotation |
| No per-org cost cap on LLM spend | Tracked in [../docs/roadmap.md §27](../docs/roadmap.md) |
| Generic passwords in `--instruction` aren't redacted from `events.jsonl` | Strengthen telemetry sanitizer per-org; or strip instruction content from logged events entirely |

---

## 12. Roadmap

What this scaffold ships with (Phase 0):

- Auth (email/password), org creation on signup, role-based RLS.
- Integrations: GitHub OAuth + AWS / K8s form-based.
- Scan creation, queue, live view via Realtime, findings list.
- Audit log writes (no UI yet).
- Worker with bounded concurrency, credential decryption, `sts:AssumeRole` for AWS, temp-file management for kubeconfig / GCP.

Phase 1 (closed beta — 4-6 weeks):

- All integration types (GitLab, Azure, GCP) with the same pattern as AWS.
- MFA enforced for admins.
- Audit log UI.
- Per-org LLM provider keys via Vault.
- Egress firewall in the sandbox.
- Scan-cancel button (worker-side).

Phase 2 (public beta — 8-10 weeks):

- Per-org quotas + cost caps.
- Webhook notifications.
- SARIF export.
- Compliance mapping (CWE / OWASP / PCI / SOC 2) on findings.
- Worker autoscaling on Fly.io.

Phase 3 (enterprise — months):

- SSO/SAML.
- Custom roles + fine-grained RBAC.
- K8s-Job-per-scan compute model.
- Self-hosted air-gapped deployment.
- Strix code refactor to allow scan-packing per worker.

Detailed: [../docs/webapp-supabase-design.md §14](../docs/webapp-supabase-design.md).

---

## 13. Troubleshooting

### Sign-up succeeds but `/dashboard` shows "no org context"

The JWT hook isn't enabled. Open Studio → Authentication → Hooks → Custom Access Token → select `public.custom_access_token_hook`. Then sign out and back in (the JWT refresh re-fetches claims).

### Worker logs `LISTEN connection dropped`

Normal during local Postgres restarts. The listener auto-reconnects; if it doesn't within ~5 seconds, restart the worker.

### Scan stays in `queued` forever

- Worker not running, or not connected to the same Supabase project.
- Verify worker logs show `listening for scan_queued notifications`.
- Check `SUPABASE_DB_URL` — must be the direct Postgres URL, not the API URL.

### Scan exits with code 1, no findings, error_message says "Docker not available"

The worker host doesn't have Docker. For local dev: `docker ps` should work in the same shell. For Fly: `flyctl machine update --privileged` and verify the Docker socket is mounted.

### Real-time UI shows no events but scan completes

- Confirm the `supabase_realtime` publication includes `scan_events`. In Studio → Database → Replication.
- Browser console may show RLS errors — confirm the user's JWT has the `org_id` claim (decode at jwt.io).

### "vault_create_secret" returns null in OAuth callback

Vault not enabled. On Supabase Cloud it's enabled by default; on local dev it requires a recent CLI version. Run `supabase --version` and update if older than 1.150.

### `npm run build` fails in Vercel with "missing SUPABASE_SERVICE_ROLE_KEY"

The service role key must be set as an *encrypted* env var in the Vercel project settings, not in `.env`. It's used at build time by some server components.

---

## 14. See Also

### In this folder

- [`frontend/README.md`](frontend/README.md) — Next.js app specifics.
- [`supabase/README.md`](supabase/README.md) — migration list and dashboard checklist.
- [`worker/README.md`](worker/README.md) — Fly.io deployment specifics.

### Repo-root reference docs

- [`https://github.com/usestrix/strix#readme`](https://github.com/usestrix/strix#readme) — Strix project overview (the engine inside).
- [`../docs/webapp-supabase-design.md`](../docs/webapp-supabase-design.md) — design rationale and phased rollout.
- [`../docs/user-inputs.md`](../docs/user-inputs.md) — every input the wrapper UI needs to surface.
- [`../docs/data-flow.md`](../docs/data-flow.md) — how data flows in the standalone CLI (analogue to §10 here).
- [`../docs/Isolation.md`](../docs/Isolation.md) — what isolation Strix already enforces (this wrapper builds on those guarantees).
- [`../docs/multiagent.md`](../docs/multiagent.md) — how agents work inside Strix (the wrapper doesn't need to know).
- [`../docs/roadmap.md`](../docs/roadmap.md) — gaps the wrapper enables addressing (REST API, multi-tenant, RBAC).

### External

- [Next.js docs](https://nextjs.org/docs)
- [Supabase docs](https://supabase.com/docs)
- [Fly.io docs](https://fly.io/docs)
- [LiteLLM providers](https://docs.litellm.ai/docs/providers)
- [Strix on PyPI](https://pypi.org/project/strix-agent/)
