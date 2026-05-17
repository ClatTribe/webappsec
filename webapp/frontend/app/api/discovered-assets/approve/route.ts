import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST /api/discovered-assets/approve
//
// Bulk-approve N discovered assets into real targets. Backed by the
// `bulk_approve_discovered_assets` SECURITY DEFINER RPC which:
//   - validates the caller is org admin
//   - creates one target per pending asset
//   - flips each discovered_asset to status='imported' with target_id
//   - writes audit_log entries
//
// Request body:
//   {
//     "asset_ids": ["uuid", "uuid", ...],
//     "config_override": { "scan_frequency": "weekly", ... }
//   }
//
// Response: per-asset outcome rows from the RPC.

const Body = z.object({
  asset_ids: z.array(z.string().uuid()).min(1).max(500),
  config_override: z.record(z.unknown()).default({}),
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

  const { data, error } = (await supabase.rpc('bulk_approve_discovered_assets', {
    p_asset_ids: parsed.data.asset_ids,
    p_config_override: parsed.data.config_override,
  })) as unknown as {
    data: Array<{
      asset_id: string;
      target_id: string | null;
      status: string;
      error: string | null;
    }> | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `approval failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = data ?? [];
  const imported = rows.filter((r) => r.status === 'imported').length;
  return NextResponse.json({
    ok: true,
    imported,
    total: rows.length,
    results: rows,
  });
}
