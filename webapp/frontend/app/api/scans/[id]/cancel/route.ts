import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// POST /api/scans/[id]/cancel — request cancellation of a queued/running scan.
//
// The actual work happens in `request_scan_cancel(uuid)` (migration 12):
//   - Verifies the caller is a member of the scan's org via has_org_role
//   - Sets cancel_requested_at and pg_notifies the worker
//   - No-ops if the scan is already terminal
//
// We just call the RPC under the user's JWT so org membership is enforced
// at the DB layer. No body needed — the path carries the scan id.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { error } = await supabase.rpc('request_scan_cancel', { p_scan_id: params.id });
  if (error) {
    // The RPC raises 'scan not found' / 'not a member of this organisation' for
    // the predictable failure modes. We forward both as 404/403 respectively
    // so the UI can show a useful toast.
    const msg = error.message ?? 'unknown error';
    if (/scan not found/i.test(msg)) {
      return NextResponse.json({ error: 'scan not found' }, { status: 404 });
    }
    if (/not a member/i.test(msg)) {
      return NextResponse.json({ error: 'not allowed' }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
