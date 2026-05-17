import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST /api/discovered-assets/reject
//
// Bulk-reject N discovered assets. Flips status to 'rejected' so
// re-discovery doesn't re-surface them. The optional reason is
// stamped into attributes so an auditor can see why an asset was
// excluded from monitoring scope.
//
// Request body:
//   {
//     "asset_ids": ["uuid", ...],
//     "reason": "test environment — out of scope" (optional, max 500)
//   }

const Body = z.object({
  asset_ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z.string().max(500).optional(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { data, error } = (await supabase.rpc('bulk_reject_discovered_assets', {
    p_asset_ids: parsed.data.asset_ids,
    p_reason: parsed.data.reason ?? null,
  })) as unknown as {
    data: number | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `rejection failed: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, rejected: data ?? 0 });
}
