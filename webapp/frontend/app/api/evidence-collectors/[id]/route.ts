import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { findCollector } from '@/lib/evidence-collectors/registry';

// Per-collector configuration management.
//
//   GET    /api/evidence-collectors/[id]          read current state
//   POST   /api/evidence-collectors/[id]          enable / configure / disable
//
// The `id` here is the collector_id string (e.g. 'github_admin'), not
// the DB row uuid. We treat the (org_id, collector_id) tuple as the
// natural key — there's at most one config row per pair.

const PostBody = z.object({
  enabled: z.boolean().optional(),
  integration_id: z.string().uuid().nullable().optional(),
  frequency_minutes: z.number().int().min(5).max(10080).optional(),
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const def = findCollector(params.id);
  if (!def) {
    return NextResponse.json({ error: 'unknown collector_id' }, { status: 404 });
  }

  const { data } = await supabase
    .from('evidence_collectors')
    .select(
      'id, collector_id, integration_id, enabled, frequency_minutes, last_run_at, last_run_status, last_run_error, last_run_evidence_count, created_at',
    )
    .eq('collector_id', params.id)
    .maybeSingle();

  return NextResponse.json({
    definition: {
      id: def.id,
      display_name: def.display_name,
      description: def.description,
      integration_type: def.integration_type,
      controls_emitted: def.controls_emitted,
      default_frequency_minutes: def.default_frequency_minutes,
    },
    config: data ?? null,
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const def = findCollector(params.id);
  if (!def) {
    return NextResponse.json({ error: 'unknown collector_id' }, { status: 404 });
  }

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  // Validate integration if supplied — must belong to this org and
  // match the collector's expected type.
  if (parsed.data.integration_id) {
    const { data: intRow } = await supabase
      .from('integrations')
      .select('id, type, status')
      .eq('id', parsed.data.integration_id)
      .maybeSingle();
    if (!intRow) {
      return NextResponse.json({ error: 'integration not found' }, { status: 404 });
    }
    if (intRow.type !== def.integration_type) {
      return NextResponse.json(
        {
          error: `wrong integration type — collector "${def.id}" expects "${def.integration_type}" but integration is "${intRow.type}"`,
        },
        { status: 400 },
      );
    }
    if (intRow.status !== 'active') {
      return NextResponse.json(
        { error: `integration is not active (status: ${intRow.status})` },
        { status: 400 },
      );
    }
  }

  const admin = createAdminClient();

  // Upsert via the (org_id, collector_id) natural key. We don't use
  // ON CONFLICT (unique index) because the supabase-js builder can
  // express it cleanly with `upsert`.
  const update: Record<string, unknown> = {
    org_id: orgId,
    collector_id: params.id,
    created_by: user.id,
  };
  if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
  if (parsed.data.integration_id !== undefined) update.integration_id = parsed.data.integration_id;
  if (parsed.data.frequency_minutes !== undefined)
    update.frequency_minutes = parsed.data.frequency_minutes;
  if (parsed.data.frequency_minutes === undefined && parsed.data.enabled === true) {
    update.frequency_minutes = def.default_frequency_minutes;
  }

  const { data: row, error } = (await admin
    .from('evidence_collectors')
    .upsert(update as never, { onConflict: 'org_id,collector_id' })
    .select(
      'id, collector_id, integration_id, enabled, frequency_minutes, last_run_at, last_run_status',
    )
    .single()) as unknown as {
    data: unknown;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'evidence_collector.configure',
    resource_type: 'evidence_collector',
    resource_id: (row as { id: string }).id,
    metadata: {
      collector_id: params.id,
      enabled: parsed.data.enabled,
      integration_id: parsed.data.integration_id,
      frequency_minutes: parsed.data.frequency_minutes,
    },
  } as never);

  return NextResponse.json({ ok: true, config: row });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
