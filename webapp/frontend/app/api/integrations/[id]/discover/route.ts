import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runDiscoveryForIntegration } from '@/lib/asset-discoverers/runner';
import { discoverersForIntegration } from '@/lib/asset-discoverers/registry';

// POST /api/integrations/[id]/discover
//
// Manual "Discover assets now" trigger. The cron handles continuous
// discovery; this endpoint is what the UI's "Discover now" button
// hits so customers don't have to wait for the next cron tick after
// connecting a fresh integration.
//
// Authz: must be an org member of the integration's org. RLS gates
// the integration read; we then hand off to the same runner the cron
// uses so behaviour is identical. We deliberately do NOT require
// admin role here — discovery is a read-only operation (no targets
// are created until bulk_approve runs, which IS admin-gated).
//
// Rate-limit safety: discovery is one upstream paginated call per
// discoverer per click. For GitHub that's at most 10 pages × 100
// repos. The cron itself runs at most every default_frequency_minutes,
// so an over-eager UI button hitting this endpoint repeatedly is
// throttled by the upstream's own rate limits — we don't add a
// wrapper-side cooldown today.

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // RLS-gated read confirms the caller can see this integration.
  const { data: integration } = await supabase
    .from('integrations')
    .select('id, org_id, type, status')
    .eq('id', params.id)
    .maybeSingle();
  if (!integration) {
    return NextResponse.json({ error: 'integration not found' }, { status: 404 });
  }
  if (integration.status !== 'active') {
    return NextResponse.json(
      { error: `integration not active (status: ${integration.status})` },
      { status: 400 },
    );
  }
  if (discoverersForIntegration(integration.type).length === 0) {
    return NextResponse.json(
      {
        error: `no discoverer wired up for integration type "${integration.type}" yet`,
      },
      { status: 400 },
    );
  }

  const outcome = await runDiscoveryForIntegration({ integrationId: integration.id });
  return NextResponse.json({ ok: true, ...outcome });
}
