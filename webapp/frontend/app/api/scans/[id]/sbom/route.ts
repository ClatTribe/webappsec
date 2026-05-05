import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET /api/scans/[id]/sbom — read the engine's CycloneDX SBOM.
//
// Engine PR #131 writes `<run_dir>/sbom.cdx.json` (CycloneDX 1.5 spec)
// listing every component the engine fingerprinted on the target. The
// worker uploads it to scan-artifacts at `<org>/<scan>/sbom.cdx.json`
// in `_upload_run_artifacts` and flips `scans.sbom_uploaded` (migration
// 032) once the file is in place.
//
// This route serves two formats off the same file:
//   - default JSON parsed response — for the SBOM viewer UI
//   - ?format=cyclonedx → raw download with auditor-friendly filename
//
// Auth: RLS on `scans` enforces org membership via the user-context
// client; storage list/download via the admin client (same pattern as
// /api/scans/[id]/compliance-pack — bucket auth doesn't extend per-row
// RLS naturally; the membership check above is the gate).

const SCAN_ARTIFACTS_BUCKET = 'scan-artifacts';
const SBOM_FILENAME = 'sbom.cdx.json';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const url = new URL(req.url);
  const format = url.searchParams.get('format');

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Visibility check via user-context client. RLS enforces org membership.
  const { data: scan, error: scanErr } = await supabase
    .from('scans')
    .select('id, org_id, run_name, completed_at, created_at, sbom_uploaded')
    .eq('id', params.id)
    .single();
  if (scanErr || !scan) {
    return NextResponse.json(
      { error: 'scan not found or no access' },
      { status: 404 },
    );
  }
  if (!scan.sbom_uploaded) {
    return NextResponse.json(
      {
        error:
          'no SBOM available for this scan — either the engine did not produce one or upload is still in flight',
      },
      { status: 404 },
    );
  }

  // Walk the storage prefix to find the SBOM. Older engines (<#131)
  // won't have the file even when the flag is set defensively, and the
  // engine's path can vary by run_id subdir layout.
  const admin = createAdminClient();
  const path = await findSbomPath(admin, `${scan.org_id}/${scan.id}`);
  if (!path) {
    return NextResponse.json(
      { error: 'SBOM file missing from storage despite flag set' },
      { status: 404 },
    );
  }

  const { data: blob, error: dlErr } = await admin.storage
    .from(SCAN_ARTIFACTS_BUCKET)
    .download(path);
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: 'failed to download SBOM from storage' },
      { status: 500 },
    );
  }
  const buf = Buffer.from(await blob.arrayBuffer());

  // Raw CycloneDX download — operator hands this to compliance / SCA
  // tooling unchanged. Filename mirrors the compliance-pack convention.
  if (format === 'cyclonedx' || format === 'raw') {
    const filename = buildFilename(scan as {
      run_name?: string | null;
      completed_at?: string | null;
      created_at?: string | null;
      id: string;
    });
    return new Response(buf, {
      status: 200,
      headers: {
        // CycloneDX uses an application/vnd.cyclonedx+json media type
        // per the spec; some validators key off it.
        'Content-Type': 'application/vnd.cyclonedx+json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  // Parsed JSON for the viewer. We re-serve rather than re-parse on
  // the client so a corrupt file produces a clean 502 here rather
  // than a hydration error there. CycloneDX 1.5 schema is well-
  // formed JSON by spec, so a parse failure is genuinely server-side.
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch {
    return NextResponse.json(
      { error: 'SBOM file is not valid JSON' },
      { status: 502 },
    );
  }
  return NextResponse.json(parsed, {
    status: 200,
    headers: { 'Cache-Control': 'private, max-age=60' },
  });
}

async function findSbomPath(
  admin: ReturnType<typeof createAdminClient>,
  prefix: string,
): Promise<string | null> {
  // Recursive search — engine layout could change. Stack-driven walk
  // matching the compliance-pack route's listAllFiles helper.
  const stack: string[] = [prefix];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const { data, error } = await admin.storage
      .from(SCAN_ARTIFACTS_BUCKET)
      .list(dir, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error || !data) continue;
    for (const entry of data) {
      const path = `${dir}/${entry.name}`;
      if (entry.id == null) {
        // Folder
        stack.push(path);
      } else if (entry.name === SBOM_FILENAME) {
        return path;
      }
    }
  }
  return null;
}

function buildFilename(scan: {
  run_name?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  id: string;
}): string {
  const dateRaw = scan.completed_at ?? scan.created_at ?? new Date().toISOString();
  const date = (dateRaw ?? '').slice(0, 10);
  const name = (scan.run_name ?? scan.id ?? 'scan').toString();
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stem = safeName ? `${safeName}-${date}` : `${scan.id}-${date}`;
  return `${stem}-sbom.cdx.json`;
}
