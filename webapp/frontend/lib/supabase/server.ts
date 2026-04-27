// Server-component Supabase client.
// Reads the user's session from cookies (set by `middleware.ts`).
// Use this in Server Components and API routes for authenticated reads.

import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // The `setAll` method was called from a Server Component (read-only cookies).
            // The user has likely been refreshed by middleware.ts already.
          }
        },
      },
    },
  );
}
