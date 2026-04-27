// Service-role Supabase client. BYPASSES RLS.
// Use ONLY for trusted server-side operations: Vault writes, integration creation, audit
// log insertion that needs to skip RLS.
//
// Importing from 'server-only' guarantees Next.js will fail the build if a 'use client'
// module ever transitively imports this file.

import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

let _admin: ReturnType<typeof createSupabaseClient> | null = null;

export function createAdminClient() {
  if (_admin) return _admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for admin client',
    );
  }

  _admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _admin;
}
