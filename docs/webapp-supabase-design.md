# Strix Web App on Next.js + Vercel + Supabase

A concrete design for wrapping Strix as a multi-user SaaS using your existing Next.js + Vercel + Supabase stack. Everything maps cleanly onto Supabase primitives **except** the Strix worker — that needs a separate compute service with a Docker daemon. Once that piece is in place, the rest is standard Supabase + Next.js plumbing.

> **TL;DR.** Vercel handles the web app and OAuth callbacks. Supabase handles auth, the database with row-level security, real-time scan updates, file storage, and credential encryption via Vault. The only piece that can't run on Vercel is the worker that spawns Strix containers — Fly.io is the recommended host. The Strix-side refactor is small: programmatic entrypoint + S3-compatible storage backend + event sink. Most of the work is standard SaaS plumbing on rails Supabase already provides.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Component Ownership](#2-component-ownership)
3. [Where the Worker Runs (the Big Decision)](#3-where-the-worker-runs-the-big-decision)
4. [Auth & Multi-Tenancy via Supabase](#4-auth--multi-tenancy-via-supabase)
5. [Real-Time Scan Updates via Supabase Realtime](#5-real-time-scan-updates-via-supabase-realtime)
6. [Integration Credentials via Supabase Vault](#6-integration-credentials-via-supabase-vault)
7. [Object Storage via Supabase Storage](#7-object-storage-via-supabase-storage)
8. [Strix-Side Changes Required](#8-strix-side-changes-required)
9. [Database Schema](#9-database-schema)
10. [OAuth Callback Pattern (GitHub Example)](#10-oauth-callback-pattern-github-example)
11. [Worker Implementation Sketch](#11-worker-implementation-sketch)
12. [Cost Sketch](#12-cost-sketch)
13. [Limitations to Plan For](#13-limitations-to-plan-for)
14. [Phased Rollout](#14-phased-rollout)
15. [Bottom Line](#15-bottom-line)

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Browser                                    │
└──────┬───────────────────────────────────┬─────────────────────────┘
       │ HTTPS                             │ Realtime channel
       ▼                                   ▼
┌──────────────────────────────┐    ┌────────────────────────────────┐
│      Vercel                   │   │  Supabase Realtime             │
│   - Next.js (App Router)     │    │  (Postgres LISTEN/NOTIFY +     │
│   - API routes (RSC + Routes)│    │   broadcast channels)          │
│   - Marketing pages          │    │                                │
└──────┬─────────────────────┬─┘    └──────────┬─────────────────────┘
       │                     │                 │
       │ supabase-js         │                 │ subscribes to
       │ (anon + RLS)        │                 │ scan:<id>
       ▼                     │                 │
┌──────────────────────────────────────────────┴─────────────────────┐
│                      Supabase                                       │
│   - Postgres + RLS (users, orgs, scans, findings, audit)           │
│   - Auth (email, OAuth, MFA, magic link)                           │
│   - Storage (artifacts, kubeconfigs, ROE files)                    │
│   - Vault / pgsodium (encrypted integration credentials)           │
│   - Realtime (LISTEN/NOTIFY broadcast)                             │
│   - Edge Functions (lightweight server logic)                      │
└────────────────────────────────────────────┬───────────────────────┘
                                             │
                                             │ row insert "scans" with status=queued
                                             │ → trigger → pg_notify
                                             │
                                             ▼
                              ┌─────────────────────────────────┐
                              │   Worker Service                │
                              │   (NOT on Vercel — see §3)      │
                              │                                 │
                              │   Long-running container        │
                              │   - Subscribes to job queue     │
                              │   - Spawns Strix CLI per job    │
                              │   - Streams events back to      │
                              │     Supabase via service-role   │
                              │   - Uploads artifacts to        │
                              │     Supabase Storage            │
                              └────────┬────────────────────────┘
                                       │ docker run
                                       ▼
                              ┌─────────────────────────────────┐
                              │  Strix sandbox container        │
                              │  (existing image, unchanged)    │
                              └─────────────────────────────────┘
```

The worker is the only non-Vercel/Supabase piece. Everything else is in stack.

---

## 2. Component Ownership

### Next.js on Vercel

| Concern | Implementation |
|---|---|
| Marketing site | Static / ISR pages |
| Auth UI | Supabase Auth UI components or `@supabase/ssr` |
| Dashboard, scan creation, scan view, integrations, team mgmt | App Router pages, RSC for initial loads, client components for live data |
| API routes | `app/api/*/route.ts` — OAuth callbacks, webhook receivers, scan triggering |
| Live scan view | Supabase Realtime client subscription |
| File uploads (kubeconfigs, ROE files) | Supabase Storage signed-URL upload |
| OAuth flows for integrations | Edge Functions or API routes; tokens written via service-role key |
| Background jobs | **Not on Vercel** — function timeout is 60s on Pro / 300s on Enterprise |

### Supabase

| Concern | Feature |
|---|---|
| Identity | Supabase Auth — email/password, OAuth, MFA, magic links |
| User table | `auth.users` extended with `public.profiles` |
| Multi-tenancy | Postgres RLS keyed on `organizations` and `org_members` |
| Database | Postgres 15+ with RLS on every tenant-scoped table |
| Real-time updates | Postgres LISTEN/NOTIFY exposed via Supabase Realtime |
| Object storage | Supabase Storage with bucket-level + row-level policies |
| Secrets | Supabase Vault (`vault.secrets`, `pgsodium`-backed) |
| OAuth callbacks | Edge Functions for short-lived logic, or Next.js API routes |
| Service-role access | Worker uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS for trusted ops |

### Worker (separate service)

| Concern | Implementation |
|---|---|
| Picks up jobs | Postgres LISTEN/NOTIFY or polling |
| Decrypts integration credentials | RPC that returns decrypted values; only the worker sees plaintext |
| Spawns Docker for Strix sandbox | Needs a host with Docker daemon |
| Streams scan events | Inserts into `scan_events` table; clients receive via Realtime |
| Uploads artifacts | Supabase Storage signed-PUT URLs |

---

## 3. Where the Worker Runs (the Big Decision)

**Strix scans cannot run on Vercel.** Reasons:

- Vercel functions have execution time limits (60s Hobby, 300s Pro, 900s Enterprise). Strix scans run for minutes to hours.
- Vercel functions are stateless and have no persistent disk for the Docker socket.
- Vercel does not let you run a Docker daemon — Strix needs to spawn `docker run` for the sandbox.

So you need a worker host. Options ranked by simplicity:

### Option A — Fly.io with privileged machine (recommended for early stage)

```
Fly machine (always-on, has Docker socket)
  ├─ Listens for jobs (Postgres LISTEN/NOTIFY or polling)
  ├─ Spawns docker run ghcr.io/usestrix/strix-sandbox per scan
  └─ Uses SUPABASE_SERVICE_ROLE_KEY to write events
```

- **Pros.** Cheap, simple, scales horizontally, Docker just works.
- **Cons.** Privileged machines (for Docker-in-Docker) cost more. Limited concurrency per machine.
- **Cost.** ~$5–30/month per worker for early traffic.

### Option B — Railway / Render / Fly with VM

Same pattern as A. Pick the operator you prefer.

### Option C — AWS ECS / Fargate task per scan

```
API route → invokes Step Function or pushes to SQS
SQS message → triggers ECS RunTask
ECS task runs Strix → writes back to Supabase via service role
ECS task exits, infra reaped
```

- **Pros.** Fully serverless. One task per scan = clean isolation. Auto-scales.
- **Cons.** Fargate doesn't natively support Docker-in-Docker. Strix would run as the main process, sandbox provisioned via sidecar or second task. More plumbing.
- **Cost.** Pay per scan-second. Good when scans are bursty.

### Option D — Kubernetes Job per scan (long-term)

```
Scan API → kubectl apply -f Job
Job pod runs Strix
Job pod terminates on completion
```

- **Pros.** Strongest isolation. Per-scan resource limits, network policies, security context. Scales infinitely.
- **Cons.** Operational overhead. Not worth it until volume justifies it.

### Option E — Modal / Beam / Replicate

Modern serverless container runtimes that *do* let you spawn Docker containers and have proper timeouts.

- **Pros.** Closest to "serverless Docker". Modal explicitly supports container spawning, GPU access, persistent volumes.
- **Cons.** Newer, more vendor-lock. Pricing model less proven for steady CPU loads.

### Recommendation

**Phase 0–1 → Option A (Fly.io).** One always-on machine listening to a Postgres queue. Migrate to Option D or move per-scan ephemeral compute to Option C/E when traffic justifies it.

Trying to make this work Vercel-only is a dead end. Don't sink time into Edge Functions or chained Vercel cron tricks.

---

## 4. Auth & Multi-Tenancy via Supabase

Supabase Auth handles essentially everything you need:

| Need | Supabase feature |
|---|---|
| Email + password | Built-in |
| OAuth (Google, GitHub, etc.) | Built-in providers |
| Magic link | Built-in |
| MFA (TOTP) | Built-in (`auth.mfa_factors`) |
| Password reset | Built-in flow |
| Session management | JWT cookie via `@supabase/ssr` |
| SSO (SAML/OIDC) | Pro plan and up |
| Custom JWT claims | `custom_access_token_hook` (Postgres function) — inject `org_id` |

### The "current org" pattern

```sql
-- After login, user has session JWT with auth.uid()
-- They pick which org to act as (or default to their primary)

-- A custom access token hook injects org_id into JWT:
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql as $$
declare
  primary_org uuid;
begin
  select org_id into primary_org
  from public.org_members
  where user_id = (event->>'user_id')::uuid
  order by created_at limit 1;

  return jsonb_set(event, '{claims,org_id}', to_jsonb(primary_org));
end;
$$;

-- RLS policies then use this claim
create policy scans_org_isolation on scans
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
```

When the user switches orgs, sign them in with a new JWT carrying the new `org_id` claim (call `supabase.auth.refreshSession()` or use a custom RPC).

---

## 5. Real-Time Scan Updates via Supabase Realtime

The naive design uses WebSockets. **Supabase Realtime replaces this entirely** and is dramatically simpler to integrate.

### Client subscribes

```typescript
const channel = supabase
  .channel(`scan:${scanId}`)
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'scan_events',
      filter: `scan_id=eq.${scanId}`,
    },
    (payload) => {
      handleEvent(payload.new);  // updates agent graph, vuln cards, logs
    }
  )
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'findings',
      filter: `scan_id=eq.${scanId}`,
    },
    (payload) => {
      addFinding(payload.new);
    }
  )
  .subscribe();
```

### Worker writes events as the scan progresses

```python
supabase.table('scan_events').insert({
    'scan_id': scan_id,
    'event_type': 'agent.created',
    'payload': {'agent_id': '...', 'name': 'JWT-Validation Agent'},
}).execute()
```

RLS on `scan_events` and `findings` ensures only the right org's clients can subscribe. Worker uses service-role key to bypass RLS for inserts.

This is the single biggest reason this stack fits — you avoid running your own WebSocket server.

---

## 6. Integration Credentials via Supabase Vault

Supabase Vault (`pgsodium`-backed) handles credential encryption natively. Each secret is column-encrypted at rest with a key managed by `pgsodium`.

### Schema

```sql
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations,
  type text not null,                -- github | gitlab | aws | azure | gcp | k8s | webhook
  name text not null,
  metadata jsonb,                    -- non-secret hints (account id, repo list, etc.)
  vault_secret_id uuid not null,     -- pointer to vault.secrets row
  created_by uuid not null references auth.users,
  created_at timestamptz default now(),
  last_used_at timestamptz
);

alter table public.integrations enable row level security;

create policy integrations_org_read on public.integrations
  for select using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy integrations_org_write on public.integrations
  for insert with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
```

### Storing a credential

```typescript
// In a Next.js route handler (server-side, with service-role client):
const { data: secretId } = await supabaseAdmin.rpc('vault_create_secret', {
  secret: JSON.stringify({
    access_token: githubToken,
    refresh_token: githubRefresh,
  }),
  name: `org_${orgId}_github_${integrationName}`,
});

await supabaseAdmin.from('integrations').insert({
  org_id: orgId,
  type: 'github',
  name: integrationName,
  metadata: { user_login: ghLogin, scopes },
  vault_secret_id: secretId,
  created_by: userId,
});
```

### Worker reading a credential

```python
# Worker has SUPABASE_SERVICE_ROLE_KEY
result = supabase_admin.rpc('vault_decrypted_secrets_by_id', {
    'secret_id': integration['vault_secret_id'],
}).execute()
plaintext = json.loads(result.data[0]['decrypted_secret'])
github_token = plaintext['access_token']
# ... use it ... wipe ...
```

The decryption RPC must be wrapped in your own SQL function that checks `org_id` matches the worker's claimed scan context, so even a stolen service-role key can't dump cross-tenant secrets without also forging the scan context.

### Audit

Every call to the decryption RPC writes an audit row. Cheap, mandatory.

### External KMS — when to migrate

Supabase Vault uses pgsodium with keys held in the database server's environment. For higher trust:

- Use Supabase's external Vault key management (Pro tier+).
- Or store ciphertexts in Supabase but encrypt/decrypt in the worker process using AWS KMS / GCP KMS, with the DEK stored encrypted in Postgres.

Phase 0–1 can use native Vault. SOC 2 / enterprise will likely move the KMS out.

### Per-integration-type credential shapes

| Integration | Best path | Stored shape |
|---|---|---|
| **GitHub** | OAuth App or GitHub App | `{access_token, refresh_token, scope}` |
| **GitLab / Bitbucket** | OAuth | Same as GitHub |
| **AWS** | IAM Role with External ID (cross-account assume role) | `{role_arn, external_id, region}`. Worker calls `sts:AssumeRole` at scan time for short-lived creds. |
| **Azure** | Service Principal | `{client_id, client_secret, tenant_id}` or Workload Identity Federation |
| **GCP** | Service Account JSON key | Encrypted JSON blob, or Workload Identity Federation |
| **Kubernetes** | Kubeconfig upload | Encrypted kubeconfig text |
| **Webhook** | URL + signing secret | `{url, secret}` |

---

## 7. Object Storage via Supabase Storage

Strix today writes to `<cwd>/strix_runs/<run-name>/`. In the SaaS:

| Artifact | Bucket | Path |
|---|---|---|
| Scan event log (jsonl) | `scan-artifacts` | `<org_id>/<scan_id>/events.jsonl` |
| Final report markdown | `scan-artifacts` | `<org_id>/<scan_id>/penetration_test_report.md` |
| Vulnerability reports | `scan-artifacts` | `<org_id>/<scan_id>/vulnerabilities/vuln-NNNN.md` |
| User-uploaded ROE files | `user-uploads` | `<org_id>/roe/<file>` |
| User-uploaded kubeconfigs | `user-uploads` | `<org_id>/kubeconfigs/<file>` (prefer Vault for actual contents) |

### Bucket policies

```sql
-- scan-artifacts bucket: org-isolated reads
create policy "org members can read their org's artifacts"
on storage.objects for select to authenticated
using (
  bucket_id = 'scan-artifacts'
  and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
);

-- only service role can write
create policy "service role writes artifacts"
on storage.objects for insert to service_role
using (bucket_id = 'scan-artifacts');
```

### Upload pattern

The worker calls Supabase Storage with the service role key to upload. Or it issues signed-PUT URLs to Strix and Strix uploads directly (cleaner separation, recommended).

---

## 8. Strix-Side Changes Required

With this stack, Strix changes are smaller than a generic SaaS rewrite would need.

### Required for Phase 0

1. **`run_scan(scan_config)` programmatic entrypoint.** Extract from `main()`. Accepts a config + storage backend + event sink, runs to completion, returns a result. Non-interactive, no CLI parsing inside.
2. **Storage backend abstraction.** Replace `Path.cwd() / "strix_runs"` with an injectable backend. Implementations: `LocalStorage` (current), `S3CompatibleStorage` for Supabase Storage. Same for the temp clone path.
3. **Event sink.** Let the tracer emit events to a callback that POSTs to a Supabase RPC, in addition to (or instead of) writing `events.jsonl` to local disk.
4. **Disable config persistence in API mode.** Don't write `~/.strix/cli-config.json` when invoked as a worker subprocess (env flag `STRIX_PERSIST_CONFIG=false`).

### Required for Phase 1+ (security-critical)

5. **Egress firewall in sandbox.** Install iptables rules at container startup based on authorized targets. Single most important security change for multi-tenant.
6. **Telemetry redaction tightening.** Instruction-derived strings should not land in events.

### Can defer indefinitely with process-per-scan

7. Refactoring `Config`, `_agent_graph`, `Tracer` to be scan-scoped. Only needed if you want one worker process to handle multiple concurrent scans. Process-per-scan ducks all of this — the worker spawns one Strix subprocess per scan and the existing globals work fine.

### Realistic effort

About **1–2 weeks** of focused refactoring. The rest is web app / infra work.

---

## 9. Database Schema

```sql
-- ============= IDENTITY =============
-- auth.users is built-in
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  plan text not null default 'free',
  created_at timestamptz default now()
);

create table public.org_members (
  user_id uuid references auth.users on delete cascade,
  org_id uuid references public.organizations on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  created_at timestamptz default now(),
  primary key (user_id, org_id)
);

-- ============= INTEGRATIONS =============
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  type text not null check (type in ('github','gitlab','aws','azure','gcp','k8s','webhook')),
  name text not null,
  metadata jsonb default '{}'::jsonb,
  vault_secret_id uuid not null,
  status text not null default 'active' check (status in ('active','revoked','expired')),
  created_by uuid not null references auth.users,
  created_at timestamptz default now(),
  last_used_at timestamptz
);

-- ============= SCANS =============
create table public.scans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid not null references auth.users,
  run_name text not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  scan_mode text not null default 'standard',
  scope_mode text default 'auto',
  diff_base text,
  instruction_text text,
  llm_provider text,
  total_input_tokens int default 0,
  total_output_tokens int default 0,
  total_cost numeric default 0,
  agents_count int default 0,
  exit_code int,
  artifact_prefix text,           -- supabase storage path prefix
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table public.scan_targets (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans on delete cascade,
  type text not null,
  value text not null,
  workspace_subdir text,
  source_integration_id uuid references public.integrations
);

create table public.scan_integrations (
  scan_id uuid references public.scans on delete cascade,
  integration_id uuid references public.integrations on delete cascade,
  primary key (scan_id, integration_id)
);

-- ============= LIVE EVENTS (drives Realtime) =============
create table public.scan_events (
  id bigserial primary key,
  scan_id uuid not null references public.scans on delete cascade,
  event_type text not null,
  payload jsonb,
  created_at timestamptz default now()
);
create index on public.scan_events (scan_id, id);

-- ============= FINDINGS =============
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans on delete cascade,
  org_id uuid not null,                  -- denormalized for RLS perf
  vuln_id text not null,                 -- vuln-0001 etc
  title text not null,
  severity text not null,
  cvss numeric,
  cwe text, cve text,
  target text, endpoint text, method text,
  description_md text,
  technical_analysis_md text,
  poc_md text,
  impact_md text,
  remediation_md text,
  affected_files jsonb,
  status text not null default 'open' check (status in ('open','triaged_real','false_positive','wont_fix','fixed')),
  triaged_by uuid references auth.users,
  triaged_at timestamptz,
  triage_notes text,
  fingerprint text,
  created_at timestamptz default now()
);

-- ============= AUDIT =============
create table public.audit_log (
  id bigserial primary key,
  org_id uuid not null,
  user_id uuid,                          -- null for worker actions
  action text not null,
  resource_type text,
  resource_id text,
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz default now()
);

-- ============= API TOKENS =============
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid references auth.users,
  name text not null,
  hashed_token text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz default now()
);

-- ============= ENABLE RLS =============
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.integrations enable row level security;
alter table public.scans enable row level security;
alter table public.scan_targets enable row level security;
alter table public.scan_integrations enable row level security;
alter table public.scan_events enable row level security;
alter table public.findings enable row level security;
alter table public.audit_log enable row level security;
alter table public.api_tokens enable row level security;

-- One representative policy (apply pattern to all tables):
create policy scans_select on public.scans for select to authenticated
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

create policy scans_insert on public.scans for insert to authenticated
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- Worker uses service-role key, which bypasses RLS — wrap in security-definer RPC:
create function public.worker_insert_scan_event(
  p_scan_id uuid, p_event_type text, p_payload jsonb
) returns void language plpgsql security definer as $$
begin
  insert into public.scan_events (scan_id, event_type, payload)
  values (p_scan_id, p_event_type, p_payload);
end;
$$;
```

This is most of the schema needed for Phase 0–1.

---

## 10. OAuth Callback Pattern (GitHub Example)

Lives in a Next.js API route on Vercel:

```typescript
// app/api/integrations/oauth/github/callback/route.ts
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyOAuthState } from '@/lib/oauth';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state'); // CSRF token w/ encoded org_id

  // 1. Verify state matches what we stored on the redirect
  const { orgId, userId } = await verifyOAuthState(state);

  // 2. Exchange code for tokens
  const tokens = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  }).then(r => r.json());

  // 3. Fetch user info to display in UI
  const ghUser = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then(r => r.json());

  // 4. Server-side Supabase client with service role
  const supabase = createServiceRoleClient();

  // 5. Create vault secret + integration row
  const { data: secretId } = await supabase.rpc('vault_create_secret', {
    secret: JSON.stringify(tokens),
    name: `org_${orgId}_github_${ghUser.login}`,
  });

  await supabase.from('integrations').insert({
    org_id: orgId,
    type: 'github',
    name: `GitHub (${ghUser.login})`,
    metadata: { login: ghUser.login, avatar_url: ghUser.avatar_url },
    vault_secret_id: secretId,
    created_by: userId,
  });

  // 6. Audit
  await supabase.from('audit_log').insert({
    org_id: orgId,
    user_id: userId,
    action: 'integration.create',
    resource_type: 'integration',
    metadata: { type: 'github', login: ghUser.login },
  });

  return Response.redirect('/app/integrations?connected=github');
}
```

Same pattern for GitLab, Bitbucket. Different shape for AWS (role ARN form), Azure (service principal), GCP (JSON upload), Kubernetes (kubeconfig upload).

---

## 11. Worker Implementation Sketch

A small Python service running on Fly.io:

```python
# worker.py
import os
import subprocess
import json
import asyncio
import psycopg
from supabase import create_client

SUPABASE_URL = os.environ['SUPABASE_URL']
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
DATABASE_URL = os.environ['SUPABASE_DB_URL']  # for LISTEN

supabase = create_client(SUPABASE_URL, SERVICE_KEY)


async def listen_for_jobs():
    async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True) as conn:
        async with conn.cursor() as cur:
            await cur.execute("LISTEN scan_queued")
            async for notify in conn.notifies():
                scan_id = notify.payload
                asyncio.create_task(run_scan_job(scan_id))


async def run_scan_job(scan_id):
    # 1. Mark as running
    supabase.table('scans').update({
        'status': 'running',
        'started_at': 'now()',
    }).eq('id', scan_id).execute()

    # 2. Fetch scan + integrations
    scan = supabase.table('scans').select(
        '*, scan_targets(*), scan_integrations(integration_id, integrations(*))'
    ).eq('id', scan_id).single().execute().data

    # 3. Decrypt integration credentials (RPC enforces org check)
    creds = {}
    for si in scan['scan_integrations']:
        integration = si['integrations']
        secret = supabase.rpc('worker_decrypt_integration', {
            'integration_id': integration['id'],
            'scan_id': scan_id,
        }).execute().data
        creds[integration['type']] = json.loads(secret)

    # 4. Build scan config + env
    env = {
        'STRIX_LLM': scan['llm_provider'],
        'LLM_API_KEY': await get_org_llm_key(scan['org_id']),
        'STRIX_STORAGE_BACKEND': 'supabase',
        'STRIX_STORAGE_BUCKET': 'scan-artifacts',
        'STRIX_STORAGE_PREFIX': f"{scan['org_id']}/{scan_id}",
        'STRIX_EVENT_SINK_URL': f"{SUPABASE_URL}/rest/v1/rpc/worker_insert_scan_event",
        'STRIX_EVENT_SINK_TOKEN': SERVICE_KEY,
        'STRIX_PERSIST_CONFIG': 'false',
    }
    if 'github' in creds:
        env['GITHUB_TOKEN'] = creds['github']['access_token']
    if 'aws' in creds:
        # Assume role with the integration's role ARN
        sts_creds = await assume_aws_role(creds['aws'])
        env['AWS_ACCESS_KEY_ID'] = sts_creds['AccessKeyId']
        env['AWS_SECRET_ACCESS_KEY'] = sts_creds['SecretAccessKey']
        env['AWS_SESSION_TOKEN'] = sts_creds['SessionToken']

    # 5. Spawn Strix
    targets = sum([['-t', t['value']] for t in scan['scan_targets']], [])
    flags = targets + ['-n', '-m', scan['scan_mode']]
    if scan['instruction_text']:
        flags += ['--instruction', scan['instruction_text']]

    proc = await asyncio.create_subprocess_exec(
        'strix', *flags,
        env={**os.environ, **env},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    # 6. Mark complete
    supabase.table('scans').update({
        'status': 'completed' if proc.returncode in (0, 2) else 'failed',
        'finished_at': 'now()',
        'exit_code': proc.returncode,
    }).eq('id', scan_id).execute()

    # 7. Wipe creds from memory
    creds.clear()


asyncio.run(listen_for_jobs())
```

Plus a Postgres trigger that fires `pg_notify('scan_queued', new.id::text)` when a scan is inserted with status `queued`:

```sql
create or replace function public.notify_scan_queued()
returns trigger language plpgsql as $$
begin
  if new.status = 'queued' then
    perform pg_notify('scan_queued', new.id::text);
  end if;
  return new;
end;
$$;

create trigger scans_queued_notify
  after insert on public.scans
  for each row execute function public.notify_scan_queued();
```

---

## 12. Cost Sketch

For early traffic (handful of scans/day, ~10 paying orgs):

| Item | Provider | Cost |
|---|---|---|
| Vercel Pro | Vercel | $20/mo |
| Supabase Pro | Supabase | $25/mo |
| Worker (Fly machine, 2 CPU / 2 GB) | Fly | ~$15/mo |
| Sandbox image registry (GHCR) | GitHub | free |
| LLM API calls | OpenAI/Anthropic | pass-through (per scan) |
| **Total fixed** | | ~**$60/mo** |

Scales to ~100 paid orgs on essentially the same infra. Only when scan concurrency grows do you need additional workers.

---

## 13. Limitations to Plan For

| Limitation | Impact | Workaround |
|---|---|---|
| **Vercel function timeout** | Cannot run scans on Vercel | Worker on Fly/Railway/etc. |
| **Supabase Vault key rotation** | Manual today (depends on plan) | Document procedure, automate when needed |
| **Supabase connection pool limit** | High-concurrency real-time can saturate | Use connection pooler (PgBouncer mode) which Supabase enables on Pro+ |
| **Realtime row-event throughput** | ~100 events/sec per channel | Batch high-frequency events (e.g. agent tool-call logs) before inserting |
| **Edge Function cold starts** | First OAuth callback can take a couple seconds | Acceptable for OAuth, not for scan-loop hot path |
| **Worker scaling** | Manual until you wire up autoscaling | Fly autoscale or move to k8s in Phase 2 |
| **Service-role key blast radius** | Full DB access if leaked | Wrap all worker DB ops in `security definer` RPCs that validate scan's org_id; rotate the key in env |

None are deal-breakers. All are well-trodden patterns.

---

## 14. Phased Rollout

### Phase 0 — Internal alpha (2–3 weeks)

- Supabase project: schema, RLS, Vault.
- Next.js app on Vercel: auth, basic dashboard, integrations page (GitHub PAT paste only), scan creation, polling-based scan view.
- Single Fly worker subscribing to pg_notify.
- Strix changes: `run_scan()` entrypoint, S3-compatible storage backend pointed at Supabase Storage, event sink that POSTs to a Supabase RPC.
- Hardcoded LLM provider keys in worker env.
- **Deliverable.** Internal team can run scans through the web UI.

### Phase 1 — Closed beta (4–6 weeks)

- GitHub OAuth flow (replace PAT paste).
- AWS IAM role assume integration.
- Real-time scan view via Supabase Realtime.
- MFA, password reset.
- Audit log.
- Per-org LLM provider keys (stored in Vault).
- Egress firewall in sandbox.
- **Deliverable.** Closed beta with 5–10 design partners.

### Phase 2 — Public beta (8–10 weeks)

- All integration types (GitLab, Azure, GCP, Kubernetes).
- Quota enforcement, cost cap.
- Webhook notifications.
- SARIF export.
- Worker autoscaling (Fly autoscale or move to ECS Fargate).
- Compliance mapping in findings.
- **Deliverable.** Public beta, paid tier.

### Phase 3 — Enterprise (months)

- Custom roles, fine-grained RBAC.
- SSO/SAML (Supabase Auth Pro).
- Self-hosted air-gapped deployment.
- Full Strix code refactor (Config, agent graph, tracer scan-scoped) so workers can pack scans.
- Move worker to Kubernetes Jobs.
- **Deliverable.** Enterprise contracts, SOC 2.

### Realistic effort estimate

For a team of 3–4 (1 backend, 1 frontend, 1 platform/infra, 1 product):

- Phase 0: 3 weeks
- Phase 1: 6 weeks
- Phase 2: 10 weeks
- Phase 3: 6+ months

So **~5 months to a paying-customer-ready product**, ~12 months to enterprise-ready.

---

## 15. Bottom Line

**Yes, the Next.js + Vercel + Supabase stack works** — and most of it is a near-perfect fit. Specifically:

- Auth, MFA, OAuth → Supabase Auth (free)
- Tenant isolation → Postgres RLS (free, defense-in-depth out of the box)
- Real-time scan UI → Supabase Realtime (replaces WebSockets)
- Credential vault → Supabase Vault / pgsodium (replaces standalone KMS for early stages)
- File storage → Supabase Storage
- OAuth callbacks, light backend logic → Vercel API routes
- Frontend → Next.js on Vercel (default)

**The one piece that doesn't fit** is the Strix worker. You need a separate compute service with a Docker daemon. **Fly.io is the lowest-friction option** at small scale.

The Strix-side refactor is genuinely small — a programmatic entrypoint + storage backend + event sink — likely **1–2 weeks** of focused work. Everything else is standard SaaS plumbing.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — Strix high-level architecture.
- [feature.md](feature.md) — every shipped feature in detail.
- [data-flow.md](data-flow.md) — how settings, sources, and credentials currently flow.
- [Isolation.md](Isolation.md) — current isolation guarantees and gaps (the wrapper closes the org-↔-org gap).
- [multiagent.md](multiagent.md), [orchestration-logic.md](orchestration-logic.md), [agent-toolcalls.md](agent-toolcalls.md) — internals the worker is wrapping.
- [user-inputs.md](user-inputs.md) — every input the wrapper has to surface as UI.
- [roadmap.md](roadmap.md) — items the wrapper enables (REST API §8, multi-scan orchestration §10, RBAC/SSO §25, etc.).
