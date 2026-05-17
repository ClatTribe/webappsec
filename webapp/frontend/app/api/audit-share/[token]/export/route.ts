// GET /api/audit-share/<token>/export — auditor portal JSON export.
//
// Returns the exact same payload as the /audit/<token> page, but as
// a downloadable JSON file the auditor can archive offline. Same
// access control (the token is the secret); same RPC backs it; same
// audit_log entry as a page load.
//
// We intentionally don't add a separate "exports" table — every
// load already records via record_audit_share_access, and the export
// path takes the same code branch. A future need (e.g. "show me how
// many exports were taken") can be served by filtering audit_log on
// action='audit_share_link.accessed' with metadata.via_export=true.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// JSON export is heavier than the page load; tell Next not to cache it
// across requests so each download reflects the latest evidence.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { token: string } },
) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase.rpc('get_audit_share_payload', {
    p_token: params.token,
  });

  if (error) {
    return NextResponse.json(
      { error: 'rpc_failed', message: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: 'not_found', message: 'Audit share link is invalid, revoked, or expired.' },
      { status: 404 },
    );
  }

  // Best-effort access bump — same as the page does. The export is
  // an access event from the auditor's side too.
  try {
    await supabase.rpc('record_audit_share_access', {
      p_token: params.token,
      p_ip: null,
      p_ua: 'export',
    });
  } catch {
    /* swallow — logging miss is not worth failing the export */
  }

  // Filename — strip the slug for predictability + tag with the date.
  const payload = data as { org?: { slug?: string }; generated_at?: string };
  const slug = payload.org?.slug ?? 'org';
  const dt = (payload.generated_at ?? new Date().toISOString()).slice(0, 10);
  const filename = `tensorshield-audit-${slug}-${dt}.json`;

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // Auditor archives should be a discrete download, not a cached
      // resource — every request hits the RPC for fresh data.
      'cache-control': 'no-store',
    },
  });
}
