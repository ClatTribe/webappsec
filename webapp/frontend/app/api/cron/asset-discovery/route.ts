import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runDiscoveryForIntegration } from '@/lib/asset-discoverers/runner';
import { discoverersForIntegration } from '@/lib/asset-discoverers/registry';

// Asset-discovery cron entrypoint.
//
//   POST /api/cron/asset-discovery
//   GET  /api/cron/asset-discovery
//     header: Authorization: Bearer $CRON_SECRET
//
// For every active integration whose `last_discovery_at` is NULL or
// older than the matching discoverer's default frequency, run
// `runDiscoveryForIntegration`. Errors per-integration are absorbed
// — the caller (Vercel Cron / external scheduler) sees a per-row
// outcome summary in the response.
//
// We do NOT use a `due_discoveries()` RPC like the evidence
// collectors do because there's at most one discoverer per
// integration type today; filtering in code keeps the surface lean.
// When/if a single integration grows multiple discoverers (e.g.
// AWS → resources + IAM users + Lambda URLs) we'll move the
// frequency math into a RPC for the same reasons.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

interface IntegrationRow {
  id: string;
  org_id: string;
  type: string;
  status: string;
  last_discovery_at: string | null;
}

async function handle(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const presented = m?.[1]?.trim();
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on the server' },
      { status: 500 },
    );
  }
  if (!presented || !constantTimeEq(presented, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: integrations, error } = (await admin
    .from('integrations')
    .select('id, org_id, type, status, last_discovery_at')
    .eq('status', 'active')) as unknown as {
    data: IntegrationRow[] | null;
    error: { message: string } | null;
  };
  if (error) {
    return NextResponse.json(
      { error: `failed to list integrations: ${error.message}` },
      { status: 500 },
    );
  }
  const rows = integrations ?? [];
  const now = Date.now();

  // Filter to "due" rows in code. Discoverer frequency drives the
  // cutoff; if multiple discoverers exist for the same integration
  // we use the MIN frequency so the row goes due whenever any one
  // of them does.
  const dueRows = rows.filter((r) => {
    const discs = discoverersForIntegration(r.type);
    if (discs.length === 0) return false;
    if (!r.last_discovery_at) return true;
    const minFreqMinutes = Math.min(...discs.map((d) => d.default_frequency_minutes));
    const ageMin = (now - Date.parse(r.last_discovery_at)) / 60_000;
    return ageMin >= minFreqMinutes;
  });

  const results: Array<{
    integration_id: string;
    org_id: string;
    type: string;
    discoverers_run: number;
    assets_upserted: number;
    errors: { discoverer_id: string; error: string }[];
  }> = [];

  // Sequential by design — matches the evidence-collectors cron;
  // keeps upstream rate-limit behaviour easy to reason about.
  for (const row of dueRows) {
    const outcome = await runDiscoveryForIntegration({ integrationId: row.id });
    results.push({
      integration_id: row.id,
      org_id: row.org_id,
      type: row.type,
      ...outcome,
    });
  }

  return NextResponse.json({
    ok: true,
    integrations_total: rows.length,
    due_count: dueRows.length,
    results,
    rolled_up: {
      assets_upserted: results.reduce((s, r) => s + r.assets_upserted, 0),
      integrations_with_errors: results.filter((r) => r.errors.length > 0).length,
    },
  });
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
