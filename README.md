# webappsec

Multi-tenant SaaS web application that wraps the [Strix](https://github.com/usestrix/strix) AI security agent. Users sign up, connect their GitHub / AWS / Kubernetes / etc. accounts, and run scans through a web UI. Findings stream in live. Each organization's data, runs, credentials, and reports are isolated end-to-end.

> **TL;DR.** Three pieces — Next.js on Vercel, Postgres + Auth + Vault on Supabase, Python worker on Fly.io — invoking the unmodified `strix` CLI as a subprocess. Multi-tenant isolation is enforced at the database layer (Row-Level Security on every tenant table, JWT-injected `org_id` claim) and at the credential layer (Vault-encrypted integration secrets, decrypted only at scan time inside the worker process).

## Repository layout

```
.
├── webapp/             the implementation
│   ├── frontend/       Next.js 14 app for Vercel
│   ├── supabase/       Postgres schema, RLS policies, RPCs (7 migrations)
│   └── worker/         Python worker for Fly.io (subscribes to scan_queued, spawns Strix)
└── docs/               design + reference documents
    ├── webapp-supabase-design.md     full design rationale, phased rollout
    ├── Isolation.md                  isolation model — five boundaries
    ├── data-flow.md                  storage / inputs / responses
    ├── feature.md                    every Strix feature the wrapper surfaces
    ├── multiagent.md                 how Strix's agents work internally
    ├── orchestration-logic.md        the prompts that drive agent behavior
    ├── agent-toolcalls.md            per-role tool-call patterns
    ├── ToolCall.md                   the XML tool-call protocol
    ├── user-inputs.md                every input the wrapper UI needs to surface
    ├── roadmap.md                    product roadmap (35 prioritized items)
    └── blog-pipeline.md              go-to-market content plan
```

## Quick start

End-to-end local dev runs in three terminals — see [`webapp/README.md`](webapp/README.md) for the full walkthrough. In short:

```bash
# Terminal 1 — database
cd webapp/supabase
supabase init && supabase start && supabase db reset

# Terminal 2 — frontend
cd webapp/frontend
cp .env.local.example .env.local      # paste keys from `supabase start` output
npm install && npm run dev            # → http://localhost:3000

# Terminal 3 — worker
cd webapp/worker
cp .env.example .env                  # paste service-role key + DB URL + LLM key
pipx install strix-agent              # the agent the worker spawns
uv sync && uv run strix-worker
```

Open http://localhost:3000, sign up, create an org, connect a GitHub OAuth integration, run your first scan.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       Browser                             │
└──────┬───────────────────────────────┬───────────────────┘
       │ HTTPS                         │ Realtime channel
       ▼                               ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  Vercel (Next.js)        │  │  Supabase Realtime       │
│   - Auth UI, dashboard   │  │  Postgres LISTEN/NOTIFY  │
│   - Scan UI              │  │  broadcast channels      │
│   - API routes (server)  │  └──────────┬───────────────┘
└──────┬─────────────────┬─┘             │
       │                 │               │ subscribes to
       │  supabase-js    │               │ scan:<id>
       ▼                 ▼               │
┌──────────────────────────────────────────────────────────┐
│                       Supabase                            │
│   - Postgres + RLS                                        │
│   - Auth (email, OAuth, MFA)                              │
│   - Vault / pgsodium (encrypted credentials)              │
│   - Storage (artifacts, kubeconfigs)                      │
│   - Realtime (LISTEN/NOTIFY broadcast)                    │
└──────────────────────────────┬───────────────────────────┘
                               │
                               │ pg_notify('scan_queued', new.id)
                               ▼
                  ┌─────────────────────────────────┐
                  │  Worker (Fly.io)                │
                  │   - LISTEN scan_queued          │
                  │   - decrypts integration creds  │
                  │   - spawns: strix -n -t … …     │
                  │   - streams events back via RPC │
                  └────────┬────────────────────────┘
                           │ docker run
                           ▼
                  ┌─────────────────────────────────┐
                  │  Strix sandbox                  │
                  │  ghcr.io/usestrix/strix-sandbox │
                  └─────────────────────────────────┘
```

For the design rationale and the alternatives we considered, read [`docs/webapp-supabase-design.md`](docs/webapp-supabase-design.md).

## How it relates to Strix

`webappsec` does **not** fork Strix. The worker installs `strix-agent` from PyPI and invokes the `strix` CLI as a subprocess. This means:

- Strix releases continue to come from [`usestrix/strix`](https://github.com/usestrix/strix).
- We pin a specific Strix version per worker deployment.
- The Strix sandbox image (`ghcr.io/usestrix/strix-sandbox`) is pulled by the worker on first scan.
- Anything Strix can do via CLI flags, the wrapper exposes via a UI form. Anything Strix can't do (yet), the wrapper can't either — see [`docs/roadmap.md`](docs/roadmap.md) for tracked gaps.

## Documentation

- **[`webapp/README.md`](webapp/README.md)** — end-to-end setup and reference for the implementation.
- **[`docs/webapp-supabase-design.md`](docs/webapp-supabase-design.md)** — design rationale: why this stack, what's in each tier, phased rollout.
- **[`docs/Isolation.md`](docs/Isolation.md)** — the five isolation boundaries (run, agent, sandbox, org, API↔worker).
- **[`docs/user-inputs.md`](docs/user-inputs.md)** — every input the wrapper UI needs to collect from users.
- **[`docs/roadmap.md`](docs/roadmap.md)** — 35 prioritized roadmap items.

The remaining `docs/*.md` files describe Strix internals (how agents work, how tool calls flow, how isolation is enforced inside the sandbox). They're useful background for anyone working on the wrapper.

## License

Apache 2.0 — same as upstream Strix. See [`LICENSE`](LICENSE).

## Acknowledgements

This repo wraps [Strix](https://github.com/usestrix/strix) — open-source AI hackers by [usestrix](https://strix.ai). All credit for the agent itself goes to that project.

> **Warning.** Only test apps you own or have explicit permission to test. You are responsible for using `webappsec` ethically and legally.
