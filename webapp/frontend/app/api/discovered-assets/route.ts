import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// GET /api/discovered-assets
//
// Paginated read of the caller's org's discovered assets. Query params:
//   - integration_id (optional)  filter to one integration
//   - status         (optional)  default: 'pending'
//   - asset_type     (optional)  filter to one type
//   - limit          (optional)  default: 200, max: 1000
//
// RLS gates the read at the row level — no need to re-check org_id
// here; the policy enforces (org_id = current_org_id()).

const ALLOWED_STATUS = new Set([
  'pending',
  'approved',
  'rejected',
  'imported',
  'superseded',
]);
const ALLOWED_TYPES = new Set([
  'repository',
  'web_application',
  'api',
  'container_image',
  'cloud_account',
  'domain',
  'ip_address',
  'local_code',
]);

export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const integrationId = url.searchParams.get('integration_id');
  const status = url.searchParams.get('status') ?? 'pending';
  const assetType = url.searchParams.get('asset_type');
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(1000, limitRaw))
    : 200;

  if (!ALLOWED_STATUS.has(status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }
  if (assetType && !ALLOWED_TYPES.has(assetType)) {
    return NextResponse.json({ error: 'invalid asset_type' }, { status: 400 });
  }

  let q = supabase
    .from('discovered_assets')
    .select(
      'id, integration_id, asset_type, canonical_id, display_name, attributes, suggested_config, confidence, status, target_id, discovered_at, last_seen_at, reviewed_at',
    )
    .eq('status', status)
    .order('confidence', { ascending: true }) // high → medium → low
    .order('discovered_at', { ascending: false })
    .limit(limit);

  if (integrationId) q = q.eq('integration_id', integrationId);
  if (assetType) q = q.eq('asset_type', assetType);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ assets: data ?? [] });
}
