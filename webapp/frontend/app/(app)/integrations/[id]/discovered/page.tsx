import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, Search } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import DiscoveredAssetsClient from './discovered-assets-client';

export const metadata = {
  title: 'Integrations · Discovered assets',
};

interface IntegrationRow {
  id: string;
  org_id: string;
  name: string;
  type: string;
  status: string;
  last_discovery_at: string | null;
}

interface DiscoveredAssetRow {
  id: string;
  integration_id: string;
  asset_type: string;
  canonical_id: string;
  display_name: string;
  attributes: Record<string, unknown> | null;
  suggested_config: Record<string, unknown> | null;
  confidence: 'high' | 'medium' | 'low';
  status: 'pending' | 'approved' | 'rejected' | 'imported' | 'superseded';
  target_id: string | null;
  discovered_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
}

// Connect-once-discover-N landing page.
// Lists every asset surfaced by discovery for one integration, with
// confidence-grouped sections and bulk approve/reject.

export default async function DiscoveredAssetsPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: integration } = (await supabase
    .from('integrations')
    .select('id, org_id, name, type, status, last_discovery_at')
    .eq('id', params.id)
    .maybeSingle()) as unknown as { data: IntegrationRow | null };

  if (!integration) {
    return (
      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-neutral-400">Integration not found.</p>
        <Link href="/integrations" className="text-sm text-cyan-300 underline">
          Back to integrations
        </Link>
      </div>
    );
  }

  // Pull pending + recently-imported in one round-trip so the UI can
  // show both. RLS-scoped; we don't need to re-check org_id.
  const { data: assets } = (await supabase
    .from('discovered_assets')
    .select(
      'id, integration_id, asset_type, canonical_id, display_name, attributes, suggested_config, confidence, status, target_id, discovered_at, last_seen_at, reviewed_at',
    )
    .eq('integration_id', integration.id)
    .in('status', ['pending', 'imported'])
    .order('confidence', { ascending: true })
    .order('discovered_at', { ascending: false })
    .limit(1000)) as unknown as { data: DiscoveredAssetRow[] | null };

  const pending = (assets ?? []).filter((a) => a.status === 'pending');
  const imported = (assets ?? []).filter((a) => a.status === 'imported');

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/integrations" className="transition-colors hover:text-neutral-300">
          Integrations
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">
          {integration.name} · Discovered assets
        </span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">
            Discovered assets
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Resources enumerated from <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-xs">{integration.name}</code>{' '}
          ({integration.type}) that we&apos;d propose monitoring. Bulk-approve the ones
          you want continuously scanned; the rest get a one-click reject so re-discovery
          doesn&apos;t re-surface them.
        </p>
        <div className="text-[11px] text-neutral-500">
          {integration.last_discovery_at
            ? `Last discovery: ${new Date(integration.last_discovery_at).toLocaleString()}`
            : 'Discovery hasn\'t run yet.'}
        </div>
      </header>

      <DiscoveredAssetsClient
        integrationId={integration.id}
        integrationType={integration.type}
        initialPending={pending}
        initialImported={imported}
        lastDiscoveryAt={integration.last_discovery_at}
      />
    </div>
  );
}
