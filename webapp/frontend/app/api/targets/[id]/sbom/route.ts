import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { cycloneDxToSpdx } from '@/lib/sbom-spdx';

// GET /api/targets/[id]/sbom?format=cyclonedx|spdx
//
// Latest SBOM for a target. Picks the most recent completed scan
// for the target that has sbom_uploaded=true, fetches the CycloneDX
// JSON from scan-artifacts storage, and either:
//   - format=cyclonedx (default): streams the CycloneDX bytes as a
//     downloadable JSON file.
//   - format=spdx: converts to SPDX 2.3 inline (no extra storage
//     round-trip) and serves with the .spdx.json extension.
//
// Procurement scenarios — "send us your SBOM for the payments
// service" — terminate here. Per-org rollup ("send us SBOMs for
// every service") is a separate /api/orgs/[id]/sbom-pack.zip
// endpoint, not in this PR.

export const dynamic = 'force-dynamic';

const SCAN_ARTIFACTS_BUCKET = 'scan-artifacts';
const SBOM_FILENAME = 'sbom.cdx.json';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'cyclonedx').toLowerCase();
  if (format !== 'cyclonedx' && format !== 'spdx') {
    return NextResponse.json(
      { error: 'format must be cyclonedx or spdx' },
      { status: 400 },
    );
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // RLS-gated read of the target. Confirms the caller can see this
  // target's org before we go service-role to fetch storage.
  const { data: target } = (await supabase
    .from('targets')
    .select('id, org_id, name, value, type')
    .eq('id', params.id)
    .maybeSingle()) as unknown as {
    data: {
      id: string;
      org_id: string;
      name: string;
      value: string;
      type: string;
    } | null;
  };
  if (!target) {
    return NextResponse.json({ error: 'target not found' }, { status: 404 });
  }

  // Latest scan with an uploaded SBOM. We deliberately don't filter
  // by status='completed' — a partially-completed scan can still have
  // an SBOM if the engine got far enough.
  const { data: scan } = (await supabase
    .from('scans')
    .select('id, completed_at, run_name')
    .eq('target_id', target.id)
    .eq('sbom_uploaded', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()) as unknown as {
    data: { id: string; completed_at: string | null; run_name: string | null } | null;
  };

  if (!scan) {
    return NextResponse.json(
      {
        error: 'no_sbom_available',
        hint: 'No scan with an SBOM has completed for this target yet. SBOMs are emitted on the next successful scan.',
      },
      { status: 404 },
    );
  }

  // Storage download goes through the admin client — bucket auth
  // doesn't extend per-row RLS; the membership check above is the
  // boundary.
  const admin = createAdminClient();
  const storagePath = `${target.org_id}/${scan.id}/${SBOM_FILENAME}`;
  const { data: blob, error: storageErr } = await admin.storage
    .from(SCAN_ARTIFACTS_BUCKET)
    .download(storagePath);

  if (storageErr || !blob) {
    return NextResponse.json(
      {
        error: `SBOM file missing or unreadable: ${storageErr?.message ?? 'unknown'}`,
        storage_path: storagePath,
      },
      { status: 500 },
    );
  }

  const cdxText = await blob.text();
  let bom: Record<string, unknown>;
  try {
    bom = JSON.parse(cdxText);
  } catch {
    return NextResponse.json(
      { error: 'stored SBOM is not valid JSON' },
      { status: 500 },
    );
  }

  // Filename for the download. Use the target's name + scan run_name
  // when present so the auditor doesn't end up with sbom.cdx.json (1).
  const safeName = (target.name || target.value)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80);
  const dt = (scan.completed_at ?? new Date().toISOString()).slice(0, 10);

  if (format === 'cyclonedx') {
    const filename = `${safeName}-${dt}.cdx.json`;
    return new NextResponse(cdxText, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.cyclonedx+json',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  }

  // SPDX path — convert inline.
  const spdx = cycloneDxToSpdx(bom, {
    documentName: `${target.name} SBOM (${dt})`,
    // Document namespace is required to be unique per SPDX spec.
    // We use the scan id so re-fetches produce stable namespaces and
    // diffs across scans are meaningful.
    documentNamespace: `https://tensorshield.ai/sbom/${target.org_id}/${scan.id}`,
  });
  const filename = `${safeName}-${dt}.spdx.json`;
  return new NextResponse(JSON.stringify(spdx, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/spdx+json',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
