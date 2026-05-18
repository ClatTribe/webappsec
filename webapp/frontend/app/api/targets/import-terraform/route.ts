import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { parseTerraformState } from '@/lib/terraform-state';

// POST /api/targets/import-terraform
//
// Phase D follow-up — accept a terraform.tfstate JSON file (multipart
// upload or raw application/json body) and ingest every scannable
// resource we recognise via the bulk_upsert_targets RPC. The customer
// already models their infra in TF; we shouldn't make them re-enter
// the same list.
//
// Body shape:
//   - multipart/form-data: `file` field carrying the tfstate
//   - application/json: the raw tfstate
//
// Query params:
//   ?project_slug=<slug>   default project for created targets
//   ?dry_run=1             parse + return targets WITHOUT writing
//                          (used by the UI's preview step)

export const dynamic = 'force-dynamic';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB — real states usually <1MB

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectSlug = url.searchParams.get('project_slug');
  const dryRun = url.searchParams.get('dry_run') === '1';

  // Read body — accept either multipart or raw JSON.
  let text: string;
  const ct = req.headers.get('content-type') ?? '';
  if (ct.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'no `file` field in form' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `tfstate exceeds ${MAX_BYTES} bytes` },
        { status: 413 },
      );
    }
    text = await file.text();
  } else {
    text = await req.text();
    if (text.length > MAX_BYTES) {
      return NextResponse.json(
        { error: `tfstate exceeds ${MAX_BYTES} bytes` },
        { status: 413 },
      );
    }
  }

  // Parse + extract.
  let parsed;
  try {
    parsed = parseTerraformState(text);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  if (parsed.targets.length === 0) {
    return NextResponse.json({
      ok: true,
      summary: { ...parsed.summary, created: 0, updated: 0, errored: 0 },
      results: [],
      hint: 'No scannable resources matched. Supported types include aws_lb, aws_api_gateway_*, google_cloud_run_*, azurerm_*_web_app, azurerm_*_function_app, kubernetes_service, kubernetes_ingress_v1.',
    });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      summary: parsed.summary,
      targets: parsed.targets,
    });
  }

  // Forward to the existing bulk-upsert RPC. The shape matches.
  const { data, error } = (await supabase.rpc('bulk_upsert_targets', {
    p_targets: parsed.targets,
    p_project_slug: projectSlug,
  } as never)) as unknown as {
    data: Array<{
      input_index: number;
      external_id: string | null;
      target_id: string | null;
      action: 'created' | 'updated' | 'error';
      error: string | null;
    }> | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `bulk upsert failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = data ?? [];
  return NextResponse.json({
    ok: true,
    summary: {
      ...parsed.summary,
      created: rows.filter((r) => r.action === 'created').length,
      updated: rows.filter((r) => r.action === 'updated').length,
      errored: rows.filter((r) => r.action === 'error').length,
    },
    results: rows,
  });
}
