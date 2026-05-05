import JSZip from 'jszip';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET /api/scans/[id]/compliance-pack — stream the engine's auditor
// bundle as a single zip download.
//
// Engine PR #129 writes ~8 files (manifest.json, control_attestation.md,
// coverage_attestation.json, findings.csv, events.jsonl excerpt +
// signature, run_meta.json, SHA256SUMS) under
// `<run_dir>/compliance_pack/<run_id>/`. The worker uploads them
// verbatim to scan-artifacts at `<org_id>/<scan_id>/compliance_pack/...`
// and flips `scans.compliance_pack_uploaded = true` (migration 030).
//
// This route:
//   1. Verifies the caller can see the scan (RLS via the user-context
//      client). 403 if they can't, 404 if the scan doesn't exist or
//      hasn't been packed.
//   2. Lists the storage prefix using the admin client (storage uses
//      its own auth model and the user-context client can't list).
//      The membership check above is what scopes the listing — we
//      never reach this point with someone else's scan.
//   3. Downloads each file, zips them in memory with JSZip, and streams
//      the response with a customer-friendly filename.
//
// The download is generated on demand rather than persisted. Storage
// would otherwise hold both the loose files (for inline preview) AND
// the zip; on-demand zipping keeps storage cost predictable.
//
// Best-effort per-file: a download error is logged but skipped so a
// partial zip beats a 500 (auditor still gets the rest of the bundle).

const SCAN_ARTIFACTS_BUCKET = 'scan-artifacts';
const PACK_PREFIX = 'compliance_pack';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Verify visibility + read the scan-shape we need for the filename.
  const { data: scan, error: scanErr } = await supabase
    .from('scans')
    .select('id, org_id, run_name, completed_at, created_at, compliance_pack_uploaded')
    .eq('id', params.id)
    .single();
  if (scanErr || !scan) {
    return new Response(JSON.stringify({ error: 'scan not found or no access' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!scan.compliance_pack_uploaded) {
    return new Response(
      JSON.stringify({
        error:
          'no compliance pack available for this scan — either the engine did not produce one or upload is still in flight',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 2. List the storage prefix. RLS on `scans` already gated us; we use
  //    the admin client because storage list/download is service-level
  //    and the per-row RLS doesn't naturally extend to bucket paths.
  const admin = createAdminClient();
  const prefix = `${scan.org_id}/${scan.id}/${PACK_PREFIX}`;
  const allFiles = await listAllFiles(admin, prefix);
  if (allFiles.length === 0) {
    return new Response(
      JSON.stringify({ error: 'compliance pack files not found in storage' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 3. Download + zip. JSZip builds the archive in memory; for the
  //    8-file pack this is cheap (typically <1 MB total). If we ever
  //    need to stream chunked, switch to the StreamWriter API.
  const zip = new JSZip();
  for (const file of allFiles) {
    try {
      const { data: blob, error: dlErr } = await admin.storage
        .from(SCAN_ARTIFACTS_BUCKET)
        .download(file);
      if (dlErr || !blob) continue;
      const buf = Buffer.from(await blob.arrayBuffer());
      // Strip the org/scan prefix — auditor's zip should look like
      // `compliance_pack/<run_id>/manifest.json`, not the storage layout.
      const inZipPath = file.startsWith(`${scan.org_id}/${scan.id}/`)
        ? file.slice(`${scan.org_id}/${scan.id}/`.length)
        : file;
      zip.file(inZipPath, buf);
    } catch {
      // Per-file download failure is non-fatal; skip and continue.
      continue;
    }
  }

  const archive = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Audit the download so the operator (and compliance team) has a
  // record of who pulled the bundle. Mirrors the audit_log entries the
  // org-secrets API route writes.
  await admin.from('audit_log').insert({
    org_id: scan.org_id,
    user_id: user.id,
    action: 'scan.compliance_pack.download',
    resource_type: 'scan',
    resource_id: scan.id,
    metadata: { file_count: allFiles.length, bytes: archive.byteLength },
  });

  const filename = buildFilename(scan as { run_name?: string | null; completed_at?: string | null; created_at?: string | null; id: string });
  // JSZip returns `Uint8Array<ArrayBufferLike>`; the Response BodyInit
  // overload accepts `Uint8Array` but TS narrows the generic too tightly.
  // A Blob wrapper is the lingua-franca form and avoids the overload mismatch.
  const body = new Blob([new Uint8Array(archive)], { type: 'application/zip' });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// Storage list paginates at 100 entries by default; recurse into
// subdirectories so we capture every file under the prefix. The pack is
// at most a single nested run-dir today, but the recursion is cheap
// insurance against future engine layouts.
async function listAllFiles(
  admin: ReturnType<typeof createAdminClient>,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [prefix];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const { data, error } = await admin.storage
      .from(SCAN_ARTIFACTS_BUCKET)
      .list(dir, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error || !data) continue;
    for (const entry of data) {
      // Storage `list` returns folders with `id == null`; files have a
      // populated id and metadata. Recurse into folders.
      const path = `${dir}/${entry.name}`;
      if (entry.id == null) {
        stack.push(path);
      } else {
        out.push(path);
      }
    }
  }
  return out;
}

function buildFilename(scan: {
  run_name?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  id: string;
}): string {
  // Auditor-friendly: <run-name>-<scan-date>-compliance-pack.zip
  // Falls back to scan id when the friendly fields are missing. We
  // sanitise to a conservative POSIX-safe charset so a customer-named
  // run with shell metachars doesn't break Content-Disposition parsing.
  const dateRaw = scan.completed_at ?? scan.created_at ?? new Date().toISOString();
  const date = (dateRaw ?? '').slice(0, 10);
  const name = (scan.run_name ?? scan.id ?? 'scan').toString();
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stem = safeName ? `${safeName}-${date}` : `${scan.id}-${date}`;
  return `${stem}-compliance-pack.zip`;
}
