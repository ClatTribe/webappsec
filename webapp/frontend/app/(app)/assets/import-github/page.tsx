// Phase B #3 — GitHub repo bulk importer.
//
// Server component shell that lists the org's connected GitHub
// integrations and delegates to a client component for the per-
// integration repo picker. The pattern matches the rest of the
// app's `(app)` shell pages — fetch the small list server-side so
// the page renders without a flicker, then the client takes over
// for the interactive bits.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Plug } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import ImportClient from './import-client';

export const metadata = {
  title: 'Import from GitHub',
};

export default async function ImportGitHubPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, type, name, metadata')
    .eq('type', 'github')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-3xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/assets" className="transition-colors hover:text-neutral-300">
          Targets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Import from GitHub</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Import from GitHub</h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          Pick repositories from your connected GitHub account. Each one becomes a target you can
          scan. Already-imported repos are flagged so you don&apos;t create duplicates.
        </p>
      </header>

      {(!integrations || integrations.length === 0) ? (
        <div className="rounded-xl border border-dashed border-amber-500/30 bg-amber-500/[0.05] px-6 py-10 text-center">
          <Plug className="mx-auto h-6 w-6 text-amber-300" strokeWidth={1.75} />
          <p className="mt-3 text-sm text-neutral-300">
            No active GitHub integration. Connect one first to enumerate your repositories.
          </p>
          <Link
            href="/integrations"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-100 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-500/30"
          >
            Connect GitHub
          </Link>
        </div>
      ) : (
        <ImportClient integrations={integrations as { id: string; name: string; metadata: Record<string, unknown> }[]} />
      )}
    </div>
  );
}
