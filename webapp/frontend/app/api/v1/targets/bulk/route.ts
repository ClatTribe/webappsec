import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST /api/v1/targets/bulk
//
// Phase D — bulk-import N targets in one round-trip. JSON body shape:
//
//   {
//     "project_slug": "payments",         // optional default project
//     "targets": [
//       {
//         "name": "Payments API",
//         "type": "repository",            // see TargetType enum
//         "value": "https://github.com/acme/payments-api",
//         "external_id": "cmdb-pa-001",    // optional, stable upsert key
//         "description": "...",
//         "metadata": { ... },             // free-shape
//         "scan_frequency": "weekly",      // manual|daily|weekly|monthly
//         "project_id": "uuid"             // optional per-row override
//       },
//       ...
//     ]
//   }
//
// Response: per-row outcomes from the `bulk_upsert_targets` RPC,
// shaped as { input_index, external_id, target_id, action, error }
// where `action` is one of created / updated / error. The endpoint
// returns 200 even when some rows error so partial success is
// observable; the caller inspects the per-row `error` field.
//
// Idempotency: re-submitting the same body is a no-op for existing
// rows. The CMDB sync script doesn't need to maintain state.
//
// Versioning: this is the v1 contract. New optional fields can be
// added without bumping; field renames require a /v2 path.

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

  const { data, error } = (await supabase.rpc('bulk_upsert_targets', {
    p_targets: parsed.data.targets,
    p_project_slug: parsed.data.project_slug ?? null,
  })) as unknown as {
    data: OutcomeRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `bulk upsert failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = data ?? [];
  const summary = {
    total: rows.length,
    created: rows.filter((r) => r.action === 'created').length,
    updated: rows.filter((r) => r.action === 'updated').length,
    errored: rows.filter((r) => r.action === 'error').length,
  };
  return NextResponse.json({ ok: true, summary, results: rows });
}
