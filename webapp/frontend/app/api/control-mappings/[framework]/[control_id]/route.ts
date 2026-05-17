import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #13 — cross-framework equivalence lookup.
//
//   GET /api/control-mappings/[framework]/[control_id]
//
// Returns every framework/control that shares a group_key with the
// supplied (framework, control_id) — used by:
//   1. The findings page: "this finding under SOC 2 CC6.1 also
//      affects ISO A.8.5, PCI 8.4, ..."
//   2. The MCP server: a future `tensorshield_equivalent_controls`
//      tool that lets an AI assistant explain cross-framework
//      implications without a DB hit per question.
//   3. Internal callers (no auth required — the data is public-
//      standard from auditor cross-reference tables).

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: { framework: string; control_id: string } },
) {
  const framework = decodeURIComponent(params.framework).trim();
  const controlId = decodeURIComponent(params.control_id).trim();
  if (!framework || !controlId) {
    return NextResponse.json({ error: 'framework + control_id required' }, { status: 400 });
  }

  // Admin client because the RPC is `security invoker` over a public
  // table — works fine with either client, but admin avoids needing
  // an auth cookie on this route (it's harmless metadata).
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('equivalent_controls', {
    p_framework: framework,
    p_control_id: controlId,
  } as never);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    group_key: string;
    group_name: string;
    framework: string;
    control_id: string;
    control_label: string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({
      query: { framework, control_id: controlId },
      group_key: null,
      group_name: null,
      mappings: [],
    });
  }

  return NextResponse.json({
    query: { framework, control_id: controlId },
    group_key: rows[0].group_key,
    group_name: rows[0].group_name,
    mappings: rows,
  });
}
