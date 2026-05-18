import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// POST /api/targets/[id]/restore — promote a dormant target back to active.
//
// The dormant sweep flips active → dormant when an asset goes quiet;
// the customer reviews and either restores or archives. This endpoint
// is the restore half — archive is the existing /api/targets/[id] DELETE.
//
// SECURITY DEFINER RPC handles the org-scoped update + audit_log
// entry in one round-trip.

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = (await supabase.rpc('restore_dormant_target', {
    p_target_id: params.id,
  })) as unknown as { data: boolean | null; error: { message: string } | null };

  if (error) {
    return NextResponse.json(
      { error: `restore failed: ${error.message}` },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: 'target not found or not dormant' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
