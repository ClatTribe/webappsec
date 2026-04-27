// Browser-side Supabase client.
// Uses the public anon key. RLS policies enforce tenant isolation automatically.
// Safe to import from 'use client' components.

import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
