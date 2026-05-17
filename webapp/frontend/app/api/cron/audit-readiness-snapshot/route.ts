import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #12 — quarterly snapshot cron entrypoint.
//
//   POST /api/cron/audit-readiness-snapshot
//     header: Authorization: Bearer $CRON_SECRET
//
// Wraps the SECURITY DEFINER snapshot_audit_readiness() RPC. Vercel
// Cron / GitHub Actions / any external scheduler can call this on
// a weekly cadence; the RPC is idempotent per (org × framework ×
// quarter) so running it weekly within Q2 keeps the Q2 row fresh
// without duplicating.
//
// We use a separate CRON_SECRET env var rather than the worker
// secret because cron callers (Vercel Cron, GitHub Actions) are
// different attacker-surface than the worker → wrapper callback.
//
// If you wire pg_cron in Supabase Cloud, this route is redundant;
// keep it for self-hosted setups + ad-hoc backfills.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
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
  const { data, error } = await admin.rpc('snapshot_audit_readiness');

  if (error) {
    return NextResponse.json(
      { error: `snapshot failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = (data ?? []) as Array<{
    out_org_id: string;
    out_framework: string;
    out_quarter: string;
    out_score: number;
    out_was_insert: boolean;
  }>;

  const inserted = rows.filter((r) => r.out_was_insert).length;
  const updated = rows.length - inserted;

  return NextResponse.json({
    ok: true,
    snapshots: rows.length,
    inserted,
    updated,
    quarter: rows[0]?.out_quarter ?? null,
  });
}

// GET is convenient for ad-hoc browser testing — same auth gate.
export async function GET(req: Request) {
  return POST(req);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
