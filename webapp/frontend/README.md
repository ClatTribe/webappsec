# Frontend (Next.js + Vercel + Supabase)

User-facing web app: login, dashboard, integrations, scan creation, live scan view, findings.

## Tech

- **Next.js 14** (App Router, Server Components)
- **TypeScript**
- **Tailwind CSS** + **shadcn/ui** (recommended; not pinned in scaffold)
- **Supabase** for auth, DB, storage, realtime
- **Zod** for input validation in API routes

## Local dev

```bash
cp .env.local.example .env.local
# fill from `supabase start` output:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

npm install
npm run dev
# → http://localhost:3000
```

## Production deploy

```bash
vercel link
vercel env pull
# OR via Vercel dashboard, set:
#   NEXT_PUBLIC_SUPABASE_URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY        (encrypted, server-side only!)
#   GITHUB_CLIENT_ID
#   GITHUB_CLIENT_SECRET
#   OAUTH_STATE_SECRET
vercel deploy --prod
```

## Folder map

```
app/
├── page.tsx                    Landing
├── login/page.tsx              Email + password sign-in
├── signup/page.tsx
├── (app)/                      Auth-required routes (layout enforces session)
│   ├── layout.tsx
│   ├── dashboard/page.tsx
│   ├── scans/
│   │   ├── page.tsx            List
│   │   ├── new/page.tsx        Create
│   │   └── [id]/page.tsx       Live view (Realtime subscription)
│   ├── findings/page.tsx
│   ├── integrations/
│   │   ├── page.tsx
│   │   ├── new/[type]/page.tsx
│   │   └── [id]/page.tsx
│   ├── team/page.tsx
│   └── settings/page.tsx
└── api/
    ├── scans/route.ts                         POST: create + queue a scan
    └── integrations/
        ├── oauth/github/callback/route.ts     GitHub OAuth completion
        └── [id]/route.ts                       DELETE: revoke an integration

lib/supabase/
├── client.ts                   Browser client (anon key, RLS-bound)
├── server.ts                   Server component client (cookie-bound)
└── admin.ts                    Service-role client (server-only, NEVER imported in 'use client')

middleware.ts                   Refreshes Supabase session on every request
```

## Important rules

1. **`SUPABASE_SERVICE_ROLE_KEY` only ever in server code.** Never imported from a `'use client'` file. Linted via `lib/supabase/admin.ts`'s server-only import.
2. **All queries from the browser go through the anon key**, which means RLS enforces tenant isolation automatically.
3. **Tenant context comes from the JWT.** The `org_id` claim is injected by the `custom_access_token_hook` migration. Don't re-derive it from cookies / URL.
4. **Real-time subscriptions are RLS-aware** — clients only receive rows their JWT can SELECT.
