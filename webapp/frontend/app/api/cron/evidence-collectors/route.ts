import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runCollector } from '@/lib/evidence-collectors/runner';

// Continuous evidence collectors — cron entrypoint.
//
//   POST /api/cron/evidence-collectors
//   GET  /api/cron/evidence-collectors        (same handler — for manual triggers)
//
//     header: Authorization: Bearer $CRON_SECRET
//
// Wraps the `due_collectors()` RPC. For every row returned (max 100
// per invocation per the RPC's limit), runs the collector through the
// runner. Errors per-collector are absorbed; the outer response shape
// reports per-row outcomes so the caller (Vercel Cron / GitHub Actions
// / external scheduler) can spot a regression in a single collector
// without aborting the batch.
//
// Idempotency: the `due_collectors()` RPC filters on
// `last_run_at + frequency_minutes < now()`. Two cron firings inside
// the same frequency window will both see the row as due ONLY if
// neither has finished yet. In practice we expect the cron to fire
// at coarser cadence than any collector's frequency (e.g. cron every
// 5min, collectors every 60min) so this isn't a concern.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

interface DueRow {
  collector_pk_id: string;
  org_id: string;
  collector_id: string;
  integration_id: string | null;
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
  const { data: due, error } = (await admin.rpc('due_collectors')) as unknown as {
    data: DueRow[] | null;
    error: { message: string } | null;
  };
  if (error) {
    return NextResponse.json(
      { error: `due_collectors RPC failed: ${error.message}` },
      { status: 500 },
    );
  }
  const dueRows = due ?? [];

  // Sequential — keeps it easy to reason about rate-limited upstream
  // APIs (GitHub: 5000 req/h per token; we'd never come close, but
  // a concurrent dispatch could blast a single org's quota). 100 rows
  // × ~5 seconds each = ~8 minutes for the worst-case full batch,
  // well within Vercel's serverless timeout for a cron.
  const results: Array<{
    org_id: string;
    collector_id: string;
    status: string;
    evidence_count: number;
    error: string | null;
  }> = [];

  for (const row of dueRows) {
    const outcome = await runCollector({
      collectorPkId: row.collector_pk_id,
      orgId: row.org_id,
      collectorId: row.collector_id,
      integrationId: row.integration_id,
    });
    results.push({
      org_id: row.org_id,
      collector_id: row.collector_id,
      status: outcome.status,
      evidence_count: outcome.evidence_count,
      error: outcome.error_message,
    });
  }

  return NextResponse.json({
    ok: true,
    due_count: dueRows.length,
    results,
    rolled_up: {
      success: results.filter((r) => r.status === 'success').length,
      partial: results.filter((r) => r.status === 'partial').length,
      error: results.filter((r) => r.status === 'error').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      evidence_rows_emitted: results.reduce((s, r) => s + r.evidence_count, 0),
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
