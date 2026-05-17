import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { listCatalog } from '@/lib/evidence-collectors/registry';

// GET /api/evidence-collectors
//
// Returns:
//   {
//     catalog: CollectorCatalogEntry[],   // static — what could be enabled
//     enabled: EvidenceCollectorRow[],    // per-org — what IS enabled
//     recent_runs: EvidenceCollectorRunRow[]  // last ~50 audit log rows
//   }
//
// Powers the /compliance/collectors page in one round-trip.

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const catalog = listCatalog();

  const [{ data: enabled }, { data: recentRuns }] = await Promise.all([
    supabase
      .from('evidence_collectors')
      .select(
        'id, collector_id, integration_id, enabled, frequency_minutes, last_run_at, last_run_status, last_run_error, last_run_evidence_count, created_at',
      )
      .order('collector_id', { ascending: true }),
    supabase
      .from('evidence_collector_runs')
      .select(
        'id, collector_id, started_at, finished_at, status, evidence_count, error_message, produced_frameworks',
      )
      .order('started_at', { ascending: false })
      .limit(50),
  ]);

  return NextResponse.json({
    catalog,
    enabled: enabled ?? [],
    recent_runs: recentRuns ?? [],
  });
}
