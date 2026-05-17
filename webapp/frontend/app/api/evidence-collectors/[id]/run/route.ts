import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runCollector } from '@/lib/evidence-collectors/runner';

// Manual collector trigger — bypass the cron cadence.
//
//   POST /api/evidence-collectors/[id]/run
//
// User-context. Useful for verifying a freshly-enabled collector
// without waiting an hour for the next cron firing. Audit-trail-wise
// the resulting evidence_collector_runs row is identical to a
// cron-triggered one — we don't tag manual runs differently because
// from the auditor's perspective "evidence was collected at T" is
// what matters, not who pulled the trigger.

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Look up the configured collector for the caller's org. RLS
  // ensures we can only see our own org's config.
  const { data: row } = await supabase
    .from('evidence_collectors')
    .select('id, org_id, collector_id, integration_id, enabled')
    .eq('collector_id', params.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json(
      { error: 'collector is not configured for this org — enable it first via POST /api/evidence-collectors/[id]' },
      { status: 404 },
    );
  }

  if (!row.enabled) {
    return NextResponse.json(
      { error: 'collector is disabled — enable it first or call POST with {enabled: true}' },
      { status: 409 },
    );
  }

  const outcome = await runCollector({
    collectorPkId: row.id,
    orgId: row.org_id,
    collectorId: row.collector_id,
    integrationId: row.integration_id,
  });

  return NextResponse.json({
    ok: true,
    status: outcome.status,
    evidence_count: outcome.evidence_count,
    produced_frameworks: outcome.produced_frameworks,
    error_message: outcome.error_message,
  });
}
