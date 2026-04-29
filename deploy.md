# Deploy

Three pieces ship to three different places. They're glued together by environment variables and a single Postgres `LISTEN/NOTIFY` channel — once you understand the glue, the rest is form-filling.

This doc covers the *production* deploy. For local dev, see [`webapp/README.md`](webapp/README.md).

---

## Topology

```
┌──────────────────────┐      HTTPS       ┌──────────────────────┐
│      Browser         │ ───────────────► │       Vercel         │
│  (Next.js client)    │ ◄─────────────── │   Next.js frontend   │
└──────────┬───────────┘   Realtime WS    └──────────┬───────────┘
           │                                          │
           │   anon key (RLS-scoped)         service-role key
           │                                          │
           ▼                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Supabase                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│  │ Postgres │  │   Auth   │  │  Vault   │  │ Realtime / WS│     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘     │
│       ▲                                                          │
└───────┼──────────────────────────────────────────────────────────┘
        │ LISTEN scan_queued / scan_cancel + service-role RPCs
        │
┌───────┴──────────────┐
│   Worker host        │   spawns Docker containers running Strix
│  (Fly.io, Railway,   │   per scan, writes findings + events.jsonl
│   VPS, etc.)         │   back into Supabase
└──────────────────────┘
```

**Three roles, three deploys:**

| Tier | Hosts on | Role | Required env |
|---|---|---|---|
| Frontend | Vercel | Browser-facing Next.js + Server-Components + API routes | Supabase URL/keys, GitHub OAuth, site URL |
| Backend | Supabase (managed) | Postgres + Auth + Storage + Vault + Realtime | RLS migrations applied |
| Worker | Fly.io / Railway / VPS | Long-running Python process; spawns Strix Docker containers | Supabase URL/service-role key, LLM key, DB URL for `LISTEN` |

---

## How the three pieces talk to each other

The non-obvious bit: **Vercel never makes a direct HTTP call to the worker.** They communicate *through Postgres*. This keeps the worker private (no public ingress) and means the only thing you have to wire up is who-knows-what-Supabase-URL.

### Path: "User clicks Run scan"

```
Browser  ──▶ Vercel API (POST /api/scans)
             │
             ├─ INSERT INTO scans (status='queued')   ◄── Supabase
             │
             └─ Postgres trigger fires:
                pg_notify('scan_queued', scan_id)
                                  │
                                  ▼
              ┌───────────────────────────────────┐
              │  Worker is LISTENing on the       │
              │  scan_queued channel              │
              │  (long-lived psycopg connection)  │
              └───────────────────────────────────┘
                                  │
                                  ▼
              Worker calls worker_claim_scan RPC (atomic)
              spawns Strix in a Docker sandbox
              writes findings + events back to Supabase
                                  │
                                  ▼
              Browser sees them via Supabase Realtime
              (postgres_changes subscription)
```

**Implication for deploy:** the worker needs *direct Postgres access* (the `SUPABASE_DB_URL`), not just the REST URL — because `LISTEN` doesn't work over PostgREST. Supabase exposes the raw Postgres URL from the dashboard's *Database → Connection string* panel.

### Path: "User clicks Cancel scan"

Same pattern, different channel:

```
Browser ─▶ Vercel API (POST /api/scans/[id]/cancel)
            │
            └─ rpc('request_scan_cancel') ◄── Supabase
                          │
                          ├─ UPDATE scans SET cancel_requested_at = now()
                          └─ pg_notify('scan_cancel', scan_id)
                                          │
                                          ▼
                            Worker receives, sends SIGTERM
                            to the matching Strix subprocess
```

### Auth flow

Three keys, three trust levels:

- **anon key** — public; sent to the browser. Only good for whatever RLS allows for the user's role.
- **service-role key** — bypasses RLS. Lives only in Vercel server-side code (API routes) and on the worker. Never sent to the browser.
- **per-user JWT** — issued by Supabase Auth on login. The browser sends it with every request; RLS reads `auth.uid()` + the `app_metadata.org_id` we inject via `custom_access_token_hook`.

---

## Deploy order

Follow the order — each step needs the previous one's URLs.

### Step 1: Supabase (the source of truth)

1. **Create a project.** [supabase.com/dashboard](https://supabase.com/dashboard) → New project. Pick the region closest to your users.
2. **Apply migrations.** From your laptop:
   ```bash
   cd webapp/supabase
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   ```
   This applies every migration in `webapp/supabase/migrations/` to the linked project, in order.
3. **Capture three values from the dashboard.** You'll paste these into Vercel + the worker:
   - **Project URL** (`Settings → API → Project URL`) → `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL`
   - **anon public key** (`Settings → API → anon public`) → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role key** (`Settings → API → service_role`) → `SUPABASE_SERVICE_ROLE_KEY` (treat this like a password — never commit, never send to a browser)
   - **Database connection string** (`Settings → Database → Connection string → URI`, *direct connection*, not pooler) → `SUPABASE_DB_URL`
4. **Configure Auth redirect URLs.** `Authentication → URL Configuration`:
   - **Site URL** = your eventual production domain (e.g. `https://youraisecurityengineer.com`). Use the `*.vercel.app` URL for the first deploy if you don't have a domain yet.
   - **Redirect URLs** — add `https://<domain>/auth/callback` and `https://<domain>/api/integrations/oauth/github/callback`.
5. **Enable the JWT hook.** `Authentication → Hooks → Custom Access Token Hook`. Select `public.custom_access_token_hook`. This is what injects the user's `org_id` into every JWT — without it, every authenticated request looks "no org context".

### Step 2: Vercel (the frontend)

1. **Import the repo.** [vercel.com/new](https://vercel.com/new) → import `ClatTribe/webappsec`.
2. **Set the Root Directory.** This is the most common setup mistake — by default Vercel builds from repo root and there's no `package.json` there. In the import wizard's **Build & Output Settings → Root Directory**, set:
   ```
   webapp/frontend
   ```
3. **Framework Preset.** Auto-detected as Next.js once root is set. Leave defaults.
4. **Environment variables.** Paste these in the import-wizard's *Environment Variables* section. Set each one for **Production**, **Preview**, and **Development** (Vercel asks you to choose):

   | Variable | Source | Notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Step 1 #3 | Public — also reaches the browser |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Step 1 #3 | Public — also reaches the browser |
   | `SUPABASE_SERVICE_ROLE_KEY` | Step 1 #3 | **Server only.** Never bundled to the client. |
   | `NEXT_PUBLIC_SITE_URL` | Your domain | **Critical for SEO** — `metadataBase`, `sitemap.xml`, `robots.txt`, all OG URLs read this. Without it, every absolute link points at `localhost`. |
   | `OAUTH_STATE_SECRET` | `openssl rand -hex 32` | Signs OAuth state tokens for the GitHub integration flow |
   | `GITHUB_CLIENT_ID` | github.com/settings/developers | OAuth App for the *integration* (different from "Login with GitHub") |
   | `GITHUB_CLIENT_SECRET` | github.com/settings/developers | Same OAuth App |

5. **Click Deploy.** ~1–2 min. Watch the build log.
6. **Custom domain** (optional, but worth doing before the first share). `Settings → Domains` → add. Once DNS propagates:
   - Update `NEXT_PUBLIC_SITE_URL` to the custom domain.
   - Go back to Step 1 #4 and update Supabase's Site URL + Redirect URLs.
   - Update the GitHub OAuth App's *Authorization callback URL* to match.

### Step 3: GitHub OAuth App (one-time)

For the in-product *integration* flow (a user connecting their GitHub org as a scan source):

1. github.com/settings/developers → **New OAuth App**
2. **Homepage URL** = `https://<your-domain>`
3. **Authorization callback URL** = `https://<your-domain>/api/integrations/oauth/github/callback`
4. Generate a client secret. Paste both into Vercel's `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

If you also want "Sign in with GitHub" (different feature), that goes in Supabase → Auth → Providers → GitHub, with its own OAuth App and callback at `https://<project>.supabase.co/auth/v1/callback`.

### Step 4: Worker (Fly.io default)

The worker is in `webapp/worker/` — Python with `fly.toml` and `Dockerfile` already committed.

```bash
cd webapp/worker

# First time only: create the Fly app
flyctl launch --no-deploy

# Wire the secrets — these mirror the worker's .env.example
flyctl secrets set \
  SUPABASE_URL=https://<project>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<from Step 1> \
  SUPABASE_DB_URL=postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres \
  STRIX_LLM=anthropic/claude-sonnet-4 \
  LLM_API_KEY=<your LLM key> \
  STRIX_IMAGE=ghcr.io/usestrix/strix-sandbox:0.1.13

# The worker mounts /var/run/docker.sock to spawn Strix containers — needs privileged.
flyctl machine update --privileged <machine-id>

flyctl deploy
```

Verify it's up:

```bash
flyctl logs    # should show "listening for scan_queued + scan_cancel notifications"
```

---

## Cross-reference: which env var goes where

The same Supabase project supplies values to two places. Here's the mapping:

| Supabase value | Vercel env | Worker env | Purpose |
|---|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | `SUPABASE_URL` | REST + Realtime endpoint |
| anon key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — | Browser-side RLS-scoped client |
| service_role key | `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin client |
| Database URL (direct) | — | `SUPABASE_DB_URL` | Worker's `LISTEN` connection (PostgREST can't do LISTEN) |

If the worker can't connect to Postgres directly with `SUPABASE_DB_URL`, the most common cause is using the *connection pooler* URL instead of the *direct* connection. The pooler is PgBouncer in transaction mode; it doesn't support `LISTEN`. Use the direct URL.

---

## Smoke tests after deploy

In order:

1. **Frontend renders.** Visit `https://<domain>/`. CSS loads. Tabs read *"AI security engineer — find real vulnerabilities, zero false positives"*.
2. **SEO infrastructure works.**
   - `https://<domain>/sitemap.xml` returns valid XML with absolute URLs.
   - `https://<domain>/robots.txt` references the sitemap.
   - `https://<domain>/opengraph-image` returns a 1200×630 PNG.
3. **Auth works.** Sign up → check email → click magic link → land on `/dashboard`.
4. **End-to-end scan.** Add a target → click "Run scan" → watch status flip from `queued` → `running` (means the worker picked it up) → `completed`. Findings appear via Realtime.
5. **Cancel works.** Start a long scan, click Cancel, hero shows *"Cancel pending"* pill, scan flips to `cancelled`. Confirms the `scan_cancel` channel is wired end-to-end.

If step 4 stalls at `queued` indefinitely: the worker isn't connected. `flyctl logs` will show whether it's listening. The most common causes are the wrong `SUPABASE_DB_URL` (pooler vs direct) or a typo in `SUPABASE_SERVICE_ROLE_KEY`.

---

## Cheaper alternatives to Fly.io for the worker

The worker is a single long-running Python process that needs:

- **Always-on.** Sleeping/cold-start hosts (Render free, Cloud Run, Lambda) **break** the `LISTEN/NOTIFY` connection — a sleeping worker misses every scan. Don't use them.
- **Privileged Docker.** Spawns sandbox containers via the host's `docker.sock`. Anything that doesn't expose Docker (most "container hosting" PaaSes) won't work without changes.
- **~2 vCPU / 2 GB RAM** baseline. Each scan can briefly spike higher.

Ranked by cost for a low-traffic deploy:

| Option | Monthly cost | Setup effort | Notes |
|---|---|---|---|
| **Hetzner CPX11 VPS** | ~€4 (~$4.50) | 30 min | Cheapest sane option. Ubuntu + Docker, run the worker container directly via `docker compose`. You manage OS updates, but for a single container that's once a month. EU-only data centers. |
| **DigitalOcean Basic Droplet** | $4–6 | 30 min | Same shape as Hetzner. Pick the 1 GB / 1 vCPU droplet (worker is fine on this for low load). NYC / SF / SG / FRA / LON / TOR. |
| **AWS Lightsail** | $3.50–5 | 30 min | Cheapest US PaaS-style VPS. Same setup as DO. Slower IO but fine. |
| **Linode (Akamai) Nanode** | $5 | 30 min | Comparable. |
| **Railway** | ~$5 free credit + usage (~$5–15) | 10 min | Closest to Fly.io's UX. Native Docker support. Privileged mode requires asking support. Auto-deploys from GitHub. Cleanest "I don't want to ssh anywhere" option. |
| **Render** | $7 (Starter) | 10 min | Easy. **Avoid the free tier** — services sleep after 15 min idle, which kills the LISTEN connection. Starter tier doesn't sleep but no Docker socket; you'd need DinD. |
| **Fly.io** (current) | ~$5 (one shared-cpu-2x machine, light usage) | 10 min | Privileged Docker is officially supported. Good logs. What `fly.toml` already targets. |
| **Self-hosted** (home server, Mac mini, old laptop) | $0 (one-time hardware) | 1 hr | Fine if you have a stable home internet connection + a way to wake the box. The worker only makes outbound calls to Supabase — no inbound network. |

### Switching from Fly.io to a VPS — concrete steps (Hetzner / DO)

If you want to drop Fly.io and save the ~$3/mo:

```bash
# On a fresh Ubuntu 22.04+ VPS:
ssh root@<vps-ip>

# Install Docker
curl -fsSL https://get.docker.com | sh

# Pull the source
git clone https://github.com/<your-fork>/webappsec.git
cd webappsec/webapp/worker

# Create a .env from the example, fill in values
cp .env.example .env
$EDITOR .env  # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL,
              # STRIX_LLM, LLM_API_KEY

# Build + run, mount the host docker.sock
docker build -t strix-worker .
docker run -d --name strix-worker \
  --restart=unless-stopped \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  strix-worker

# Watch the logs
docker logs -f strix-worker
```

You should see `"listening for scan_queued + scan_cancel notifications"` within a few seconds. That's the worker fully wired.

For redeploys: `git pull && docker build … && docker stop strix-worker && docker rm strix-worker && docker run …`. A 10-line shell script in `/usr/local/bin/redeploy-worker.sh` makes this one-command.

### Switching to Railway

```bash
# Install Railway CLI
npm i -g @railway/cli
railway login

cd webapp/worker
railway init                     # creates a project
railway add                      # creates a service from this directory's Dockerfile
railway variables set \
  SUPABASE_URL=… \
  SUPABASE_SERVICE_ROLE_KEY=… \
  SUPABASE_DB_URL=… \
  STRIX_LLM=… \
  LLM_API_KEY=…
railway up                       # deploys
```

Railway uses the existing `Dockerfile` automatically. To enable Docker socket access (for spawning Strix sandboxes), file a support ticket asking for privileged mode — they grant it for legitimate cases.

---

## Going to production — a few things the deploy doesn't cover

These aren't blockers for shipping; they're things to set up *soon* after.

- **Backups.** Supabase auto-backs up daily on the paid plan; for free-tier projects, set up your own `pg_dump` cron (one-liner from any host with `psql`).
- **Monitoring.** Vercel has built-in Web Analytics. The worker has no health check yet (roadmap §12) — until then, `flyctl logs --tail` or your VPS's `journalctl` is your friend.
- **Cost caps.** The worker can run unbounded LLM scans against unbounded targets. Set an alert on your LLM provider's spend dashboard. Roadmap §5 covers in-app limits.
- **Domain mail.** Transactional emails (signup verification, scan-finished notifications) need a verified sender domain on Resend / Postmark / SES. Roadmap §3 (signup mechanics) and §5 (transactional emails) track this.

---

## Updating after the first deploy

| You changed | Vercel | Worker | Supabase |
|---|---|---|---|
| Frontend code (`webapp/frontend/**`) | Auto-deploys on `git push` to your default branch | — | — |
| Worker code (`webapp/worker/**`) | — | `flyctl deploy` (or `docker build && docker run` on a VPS) | — |
| New SQL migration (`webapp/supabase/migrations/**`) | — | — | `supabase db push` |
| New env var | Vercel dashboard → Settings → Environment Variables → Add → redeploy | `flyctl secrets set FOO=bar` (or edit `.env` + restart container on a VPS) | — |

For production, point Vercel at the `main` branch — every merge auto-deploys. The worker doesn't auto-deploy from git; that's an explicit `flyctl deploy` (or VPS redeploy) step. Treat that as a feature: SQL changes go first, then worker, then frontend.
