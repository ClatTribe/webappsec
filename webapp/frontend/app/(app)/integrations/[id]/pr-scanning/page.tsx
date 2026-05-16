import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import PrScanningClient from './pr-scanning-client';

// Tier II #7 — per-integration "Enable PR scanning" page.
//
// One screen, one action: pair a GitHub integration with a single
// repository so the wrapper accepts pull_request webhook deliveries
// from it. Mints a webhook secret on first save and shows it ONCE so
// the user can paste it into github.com's webhook UI.
//
// Multi-repo support per integration is a follow-up — for now the
// 1:1 integration↔repo binding matches the apply-patch flow's
// "most-recently-created active github integration" assumption.

export default async function PrScanningPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const { data: integration } = await supabase
    .from('integrations')
    .select('id, type, name, status, metadata')
    .eq('id', params.id)
    .single();

  if (!integration) notFound();
  if (integration.type !== 'github') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-rose-300">
          PR scanning is only available for GitHub integrations.
        </p>
        <Link href="/integrations" className="text-cyan-300 underline">
          ← Back to integrations
        </Link>
      </div>
    );
  }

  const meta = (integration.metadata ?? {}) as {
    login?: string;
    repo_full_name?: string;
    webhook_secret?: string;
  };

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/integrations" className="transition-colors hover:text-neutral-300">
          Integrations
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">PR scanning</span>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          PR scanning · {integration.name}
        </h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          When enabled, TensorShield receives <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-xs">pull_request</code> webhooks
          from the repo below and runs a diff-mode scan on every PR. Findings
          are posted back to the PR as a sticky comment that updates on each push.
        </p>
      </header>

      <PrScanningClient
        integrationId={integration.id}
        initialEnabled={!!meta.webhook_secret && !!meta.repo_full_name}
        initialRepoFullName={meta.repo_full_name ?? null}
        login={meta.login ?? null}
      />
    </div>
  );
}
