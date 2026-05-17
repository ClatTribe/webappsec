import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Shield, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import CompensatingClient from './compensating-client';
import type { CompensatingControl } from '@/lib/supabase/types';

// Tier II #13 — compensating controls dashboard.
//
// /compliance/compensating
//
// List + create form. Server-renders the active list via the
// compensating_controls_active() RPC; the client handles create +
// revoke + cross-framework display.

export const metadata = {
  title: 'Compliance · Compensating controls',
};

export default async function CompensatingPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await supabase.rpc('compensating_controls_active', {
    p_framework: null,
  } as never);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Link href="/compliance" className="transition-colors hover:text-neutral-300">
            Compliance
          </Link>
          <span>·</span>
          <span className="text-neutral-300">Compensating controls</span>
        </nav>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Compensating controls</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Declare mitigations for controls you can&apos;t satisfy directly.
          Auditor-visible; surfaces on your public trust page next to the
          failing control with the rationale you accepted. Expiry triggers
          a review reminder 30 days out.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-neutral-500">
          <Link
            href="/compliance/readiness"
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-neutral-200 hover:underline"
          >
            <ChevronRight className="h-3 w-3 rotate-180" strokeWidth={2.5} />
            Audit-readiness scores
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          Failed to load: {error.message}
        </div>
      )}

      <CompensatingClient
        initialControls={(data ?? []) as CompensatingControl[]}
      />
    </div>
  );
}
