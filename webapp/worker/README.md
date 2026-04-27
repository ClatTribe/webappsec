# Strix Worker Service

Long-running Python service that picks up queued scans from Supabase, decrypts integration credentials, spawns Strix as a subprocess, and streams events back to Supabase. Designed to run on Fly.io (or any host with Docker).

## Responsibilities

1. `LISTEN scan_queued` on Postgres — wakes on new scans.
2. Fetch scan + targets + linked integrations.
3. Decrypt integration credentials via `worker_decrypt_integration` RPC.
4. For AWS-type integrations, call `sts:AssumeRole` to get short-lived creds.
5. Spawn `strix -n -t … --instruction …` as a subprocess.
6. Tail Strix's event stream → forward to Supabase via `worker_insert_scan_event` RPC.
7. On exit, call `worker_finish_scan` with status + exit code + LLM stats.
8. Wipe credentials from memory.

## Local dev

```bash
cp .env.example .env
# fill in: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL,
#          STRIX_LLM, LLM_API_KEY (or per-org keys via Vault)

uv sync
uv run strix-worker
```

The worker needs:

- **Strix CLI installed** locally: `pipx install strix-agent` or `uv tool install strix-agent`.
- **Docker daemon running** — Strix spawns the sandbox container.

## Production deploy on Fly.io

```bash
flyctl launch --no-deploy
flyctl secrets set \
  SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  SUPABASE_DB_URL=postgres://... \
  STRIX_LLM=openai/gpt-5.4
flyctl deploy
```

The included `Dockerfile` installs Strix from PyPI and runs the worker. `fly.toml` configures a privileged machine so Docker-in-Docker works (Strix spawns the sandbox image as a sibling container via the host Docker socket).

For higher trust: instead of mounting the host Docker socket, use a per-scan Fargate / ECS / k8s Job per Phase 2 of the rollout plan.

## Environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | https://xxx.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (DO NOT EXPOSE TO CLIENT) |
| `SUPABASE_DB_URL` | Direct Postgres connection string for `LISTEN/NOTIFY` |
| `STRIX_LLM` | Default model id; can be overridden per-org if `organizations.llm_provider` is set |
| `LLM_API_KEY` | Default LLM key; per-org keys take precedence (decrypted via `worker_decrypt_org_llm_key`) |
| `STRIX_IMAGE` | Sandbox image, default `ghcr.io/usestrix/strix-sandbox:0.1.13` |
| `WORKER_CONCURRENCY` | Max simultaneous scans per worker process (default `1`) |
| `STRIX_BIN` | Path to the `strix` binary (default `strix`) |
| `LOG_LEVEL` | `DEBUG`, `INFO` (default), `WARNING`, `ERROR` |
