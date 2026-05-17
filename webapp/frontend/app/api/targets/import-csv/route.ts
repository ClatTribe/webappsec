import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST /api/targets/import-csv
//
// Accepts a CSV body (multipart with field `file`, or raw text/csv
// in the body) and forwards each row through the same
// `bulk_upsert_targets` RPC the JSON endpoint uses.
//
// CSV column conventions:
//   name              required
//   type              required — one of the TargetType enum values
//   value             required
//   external_id       optional — stable idempotency key
//   description       optional
//   scan_frequency    optional — manual|daily|weekly|monthly
//   project_slug      optional per-row project (overrides query param)
//   tags              optional — comma-separated; lands under metadata.tags
//   <any other>       lands under metadata.<colname>
//
// Empty cells become null. Unknown columns are forwarded into
// metadata so a customer's CMDB columns (owner, env, cost_center)
// survive the round-trip and become queryable.
//
// Query params:
//   ?project_slug=<slug>   default project for rows that don't set one

export const dynamic = 'force-dynamic';

const KNOWN_TARGET_COLUMNS = new Set([
  'name',
  'type',
  'value',
  'external_id',
  'description',
  'scan_frequency',
  'project_id',
  'project_slug',
  'tags',
]);

const TargetType = z.enum([
  'local_code',
  'repository',
  'web_application',
  'domain',
  'ip_address',
  'api',
  'container_image',
  'cloud_account',
]);

const ScanFrequency = z.enum(['manual', 'daily', 'weekly', 'monthly']);

interface OutcomeRow {
  input_index: number;
  external_id: string | null;
  target_id: string | null;
  action: 'created' | 'updated' | 'error';
  error: string | null;
}

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const queryProjectSlug = url.searchParams.get('project_slug');

  // Read the body — multipart file upload OR raw text/csv. Either
  // shape lands here as a string.
  let csvText: string;
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'no `file` field in form' }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'CSV exceeds 5MB' }, { status: 413 });
    }
    csvText = await file.text();
  } else if (contentType.startsWith('text/csv') || contentType.startsWith('text/plain')) {
    csvText = await req.text();
    if (csvText.length > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'CSV exceeds 5MB' }, { status: 413 });
    }
  } else {
    return NextResponse.json(
      {
        error:
          'unsupported content-type; expected multipart/form-data with `file` or text/csv body',
      },
      { status: 415 },
    );
  }

  // Parse with header row. dynamicTyping=false so everything stays
  // string — we don't want "1234" to become a number.
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    // Aggregate the first few errors with row numbers so the UI can
    // point the user at the offending lines.
    return NextResponse.json(
      {
        error: 'CSV parse failed',
        parse_errors: parsed.errors.slice(0, 10).map((e) => ({
          row: e.row,
          message: e.message,
        })),
      },
      { status: 400 },
    );
  }
  const rows = parsed.data;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'CSV has no data rows' }, { status: 400 });
  }
  if (rows.length > 500) {
    return NextResponse.json(
      { error: `CSV has ${rows.length} rows; max 500 per import. Split and retry.` },
      { status: 413 },
    );
  }

  // Translate CSV rows → bulk_upsert_targets JSON. Any column not in
  // KNOWN_TARGET_COLUMNS gets buried in metadata so CMDB-specific
  // columns ride through unchanged.
  const validationErrors: Array<{ row_index: number; error: string }> = [];
  const targets: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const metadata: Record<string, unknown> = {};
    const tagsRaw = r.tags?.trim();
    if (tagsRaw) {
      metadata.tags = tagsRaw
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean);
    }
    for (const [k, v] of Object.entries(r)) {
      if (!KNOWN_TARGET_COLUMNS.has(k) && v !== undefined && v !== null && v !== '') {
        metadata[k] = v;
      }
    }

    // Per-row project_slug → look up in DB. We bundle this as
    // project_id (UUID) for the RPC because the RPC's outer
    // p_project_slug arg is a single default; per-row overrides have
    // to be UUIDs.
    let rowProjectId: string | undefined;
    if (r.project_slug && r.project_slug.trim()) {
      const slug = r.project_slug.trim();
      const { data: proj } = (await supabase
        .from('projects')
        .select('id')
        .eq('slug', slug)
        .is('archived_at', null)
        .maybeSingle()) as unknown as { data: { id: string } | null };
      if (!proj) {
        validationErrors.push({
          row_index: i + 1,
          error: `project_slug "${slug}" not found`,
        });
        continue;
      }
      rowProjectId = proj.id;
    } else if (r.project_id && r.project_id.trim()) {
      rowProjectId = r.project_id.trim();
    }

    const typeParsed = TargetType.safeParse(r.type?.trim());
    if (!typeParsed.success) {
      validationErrors.push({
        row_index: i + 1,
        error: `invalid type "${r.type ?? '<empty>'}"`,
      });
      continue;
    }
    const freqParsed = r.scan_frequency
      ? ScanFrequency.safeParse(r.scan_frequency.trim())
      : null;
    if (freqParsed && !freqParsed.success) {
      validationErrors.push({
        row_index: i + 1,
        error: `invalid scan_frequency "${r.scan_frequency}"`,
      });
      continue;
    }
    if (!r.name?.trim() || !r.value?.trim()) {
      validationErrors.push({
        row_index: i + 1,
        error: 'name and value are required',
      });
      continue;
    }

    targets.push({
      name: r.name.trim(),
      type: typeParsed.data,
      value: r.value.trim(),
      external_id: r.external_id?.trim() || undefined,
      description: r.description?.trim() || undefined,
      scan_frequency: freqParsed?.data ?? undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      project_id: rowProjectId,
    });
  }

  if (targets.length === 0) {
    return NextResponse.json(
      {
        error: 'no valid rows after validation',
        validation_errors: validationErrors,
      },
      { status: 400 },
    );
  }

  // Forward to the same RPC the JSON path uses. Validation errors
  // from the pre-flight pass are surfaced alongside the RPC's per-
  // row outcomes so the UI can show both.
  const { data, error } = (await supabase.rpc('bulk_upsert_targets', {
    p_targets: targets,
    p_project_slug: queryProjectSlug ?? null,
  })) as unknown as {
    data: OutcomeRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `bulk upsert failed: ${error.message}`, validation_errors: validationErrors },
      { status: 500 },
    );
  }

  const rpcRows = data ?? [];
  const summary = {
    total: targets.length + validationErrors.length,
    parsed: targets.length,
    pre_validation_errored: validationErrors.length,
    created: rpcRows.filter((r) => r.action === 'created').length,
    updated: rpcRows.filter((r) => r.action === 'updated').length,
    rpc_errored: rpcRows.filter((r) => r.action === 'error').length,
  };
  return NextResponse.json({
    ok: true,
    summary,
    validation_errors: validationErrors,
    results: rpcRows,
  });
}
