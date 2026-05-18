import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateMcpRequest, hasScope } from '@/lib/mcp/auth';

// POST /api/v1/targets/bulk
//
// Phase D — bulk-import N targets in one round-trip. Two auth paths:
//
//   1. Session cookie (browser → /targets/import-csv flow)
//      Uses `bulk_upsert_targets(p_targets, p_project_slug)` which
//      reads org_id from the user's JWT via current_org_id().
//
//   2. Bearer API token (CI / CMDB sync scripts)
//      Validates via authenticateMcpRequest, requires the `mcp:scan`
//      scope (creating targets is a write-scope action), then calls
//      `bulk_upsert_targets_for_org(org_id, user_id, ...)` with the
//      org_id pulled from the resolved key. Service-role-only RPC;
//      route invokes via the admin client.
//
// Both paths return the same response shape so callers don't care
// which auth they used.
//
// Idempotency: re-submitting the same body is a no-op for existing
// rows (the underlying RPCs upsert on (org_id, external_id) when
// external_id is set, else on (org_id, value)).
//
// Versioning: this is the v1 contract. New optional fields land
// without bumping; field renames require /v2.

export const dynamic = 'force-dynamic';

const TargetRow = z.object({
  name: z.string().min(1).max(200),
  type: z.enum([
    'local_code',
    'repository',
    'web_application',
    'domain',
    'ip_address',
    'api',
    'container_image',
    'cloud_account',
  ]),
  value: z.string().min(1).max(2000),
  external_id: z.string().min(1).max(200).optional(),
  description: z.string().max(2048).optional(),
  metadata: z.record(z.unknown()).optional(),
  scan_frequency: z.enum(['manual', 'daily', 'weekly', 'monthly']).optional(),
  project_id: z.string().uuid().optional(),
});

const Body = z.object({
  project_slug: z.string().min(1).max(64).optional(),
  targets: z.array(TargetRow).min(1).max(500),
});

interface OutcomeRow {
  input_index: number;
  external_id: string | null;
  target_id: string | null;
  action: 'created' | 'updated' | 'error';
  error: string | null;
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // --- Auth path resolution -------------------------------------
  // We check for a Bearer header first because that's the explicit
  // signal a machine-to-machine caller sends. Session-cookie auth
  // is the fallback for browser-originated submissions.
  const authHeader = req.headers.get('authorization');
  if (authHeader && /^bearer\s+/i.test(authHeader)) {
    return await handleApiToken(req, parsed.data);
  }
  return await handleSession(parsed.data);
}

async function handleSession(input: z.infer<typeof Body>): Promise<Response> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = (await supabase.rpc('bulk_upsert_targets', {
    p_targets: input.targets,
    p_project_slug: input.project_slug ?? null,
  } as never)) as unknown as {
    data: OutcomeRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `bulk upsert failed: ${error.message}` },
      { status: 500 },
    );
  }
  return buildSuccess(data ?? []);
}

async function handleApiToken(
  req: Request,
  input: z.infer<typeof Body>,
): Promise<Response> {
  const ctx = await authenticateMcpRequest(req.headers);
  if (!ctx) {
    return NextResponse.json(
      { error: 'invalid or revoked API token' },
      { status: 401 },
    );
  }
  if (!hasScope(ctx, 'mcp:scan')) {
    return NextResponse.json(
      {
        error:
          'API token is missing the mcp:scan scope (required for bulk target import — creating targets is a write action)',
      },
      { status: 403 },
    );
  }

  // Service-role admin client invokes the org-scoped sibling RPC.
  // We pass a synthetic user_id of all zeros because there's no
  // human caller — the audit_log entry the RPC writes carries
  // source='api_token' so an auditor can still tell who acted.
  const admin = createAdminClient();
  const { data, error } = (await admin.rpc('bulk_upsert_targets_for_org', {
    p_org_id: ctx.orgId,
    p_user_id: null,
    p_targets: input.targets,
    p_project_slug: input.project_slug ?? null,
  } as never)) as unknown as {
    data: OutcomeRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `bulk upsert failed: ${error.message}` },
      { status: 500 },
    );
  }
  return buildSuccess(data ?? [], { auth: 'api_token', key_id: ctx.keyId });
}

function buildSuccess(
  rows: OutcomeRow[],
  meta: Record<string, unknown> = {},
): Response {
  const summary = {
    total: rows.length,
    created: rows.filter((r) => r.action === 'created').length,
    updated: rows.filter((r) => r.action === 'updated').length,
    errored: rows.filter((r) => r.action === 'error').length,
  };
  return NextResponse.json({ ok: true, summary, results: rows, ...meta });
}
