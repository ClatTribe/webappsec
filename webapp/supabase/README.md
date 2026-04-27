# Supabase Layer

Postgres schema, RLS policies, Vault helpers, and worker RPCs for the Strix web app.

## Files

| Migration | Purpose |
|---|---|
| `20260427000000_init_schema.sql` | Tables: profiles, organizations, org_members, integrations, scans, scan_targets, scan_integrations, scan_events, findings, audit_log, api_tokens |
| `20260427000001_rls_policies.sql` | Row-level security on every tenant table, keyed on `auth.jwt() ->> 'org_id'` |
| `20260427000002_jwt_hook.sql` | Custom access token hook that injects `org_id` into the JWT |
| `20260427000003_vault_helpers.sql` | Wrapper RPCs to create/read Vault secrets with org-isolation checks |
| `20260427000004_pg_notify_trigger.sql` | Fires `pg_notify('scan_queued', new.id)` so the worker wakes up |
| `20260427000005_worker_rpcs.sql` | Security-definer RPCs the worker calls (insert events, decrypt creds, finalize scan) |
| `20260427000006_realtime.sql` | Adds `scan_events` and `findings` to the Realtime publication |

## Local development

```bash
brew install supabase/tap/supabase
cd webapp/supabase
supabase init       # only first time
supabase start
supabase db reset   # applies all migrations from scratch
```

`supabase start` prints the local URLs and keys — paste them into `webapp/frontend/.env.local` and `webapp/worker/.env`.

## Deploying to Supabase Cloud

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

## Enabling Vault on a fresh project

Vault is auto-enabled on Supabase Cloud projects. Locally, `supabase start` enables it by default in recent CLI versions.

## After deployment

1. **Enable the JWT hook.** Dashboard → Authentication → Hooks → "Custom Access Token" → select `public.custom_access_token_hook`.
2. **Configure Auth providers.** Dashboard → Authentication → Providers → enable Email, GitHub (if using login with GitHub), etc.
3. **Set the OAuth secret.** `OAUTH_STATE_SECRET` env var — used by the frontend to sign OAuth state tokens for the GitHub *integration* flow (different from auth login).
