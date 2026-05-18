import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Stale-asset sweep cron entrypoint.
//
//   POST /api/cron/dormant-sweep
//   GET  /api/cron/dormant-sweep
//     header: Authorization: Bearer $CRON_SECRET
//
// Daily-cadence hygiene sweep. Calls `sweep_dormant_targets()` which
// flips active → dormant when any of:
//   - last_scan_at older than 90 days (scheduled but stale)
//   - never scanned + registered >60 days ago
//   - parent integration is no longer active
//
// Returns per-org rollup so the caller can spot abuse (e.g. one org
// flipping 50 rows in a single sweep usually means an integration
// just went away).
//
// We emit one audit_log entry per transition so the org's auditor
// portal can show "we noticed X went dormant on date Y".

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

interface SweepRow {
  target_id: string;
  org_id: string;
  old_status: string;
  new_status: string;
  reason: string;
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

  const url = new URL(req.url);
  const noScanAgeDays = clampInt(
    url.searchParams.get('no_scan_age_days'),
    7,
    365,
    90,
  );
  const neverScannedDays = clampInt(
    url.searchParams.get('never_scanned_days'),
    7,
    365,
    60,
  );

  const admin = createAdminClient();
  const { data, error } = (await admin.rpc(
    'sweep_dormant_targets',
    {
      p_no_scan_age_days: noScanAgeDays,
      p_never_scanned_days: neverScannedDays,
    } as never,
  )) as unknown as { data: SweepRow[] | null; error: { message: string } | null };

  if (error) {
    return NextResponse.json(
      { error: `sweep failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = data ?? [];

  // Emit one audit_log entry per transition. Done from the cron rather
  // than the RPC so the row carries the cron's user_id=null (system).
  if (rows.length > 0) {
    const auditPayload = rows.map((r) => ({
      org_id: r.org_id,
      user_id: null,
      action: 'target.flipped_dormant',
      resource_type: 'target',
      resource_id: r.target_id,
      metadata: { reason: r.reason },
    }));
    await admin.from('audit_log').insert(auditPayload as never);
  }

  // Per-org rollup so monitoring can spot a single org flipping many.
  const perOrg: Record<string, { count: number; reasons: Record<string, number> }> = {};
  for (const r of rows) {
    const bucket = (perOrg[r.org_id] ??= { count: 0, reasons: {} });
    bucket.count += 1;
    bucket.reasons[r.reason] = (bucket.reasons[r.reason] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    swept: rows.length,
    thresholds: {
      no_scan_age_days: noScanAgeDays,
      never_scanned_days: neverScannedDays,
    },
    per_org: perOrg,
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

function clampInt(raw: string | null, min: number, max: number, dflt: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
