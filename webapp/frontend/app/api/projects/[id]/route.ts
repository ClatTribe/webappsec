import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET    /api/projects/[id]              single project + summary + targets
// PATCH  /api/projects/[id]              partial update (name, criticality, owner, tags)
// DELETE /api/projects/[id]              soft archive (sets archived_at)
//
// Param can be either a UUID or the per-org slug — both are accepted
// so deep-links from the UI (`/projects/payments-service`) and admin
// scripts (UUIDs) work uniformly.

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2048).nullable().optional(),
    criticality: z.enum(['tier_1', 'tier_2', 'tier_3', 'tier_4']).optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    tags: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'empty patch body' });

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const isUuid = UUID_RE.test(params.id);
  const projectQ = supabase
    .from('project_summary_v')
    .select(
      'project_id, slug, name, criticality, owner_user_id, tags, archived_at, target_count, last_scan_at, open_critical, open_high, open_medium, open_low, open_total',
    )
    .is('archived_at', null);
  const { data: project } = (await (isUuid
    ? projectQ.eq('project_id', params.id)
    : projectQ.eq('slug', params.id)
  ).maybeSingle()) as unknown as {
    data: { project_id: string } | null;
  };

  if (!project) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  // Pull the project's targets in the same round-trip so the detail
  // page renders without a second fetch.
  const { data: targets } = await supabase
    .from('targets')
    .select('id, name, type, value, status, last_scan_at, scan_frequency')
    .eq('project_id', project.project_id)
    .eq('status', 'active')
    .order('last_scan_at', { ascending: false, nullsFirst: false });

  // Also pull the per-target finding counts so the detail page can
  // show "payments-api: 2 critical · 5 high".
  const targetIds = (targets ?? []).map((t) => t.id);
  let perTargetCounts: Record<string, { open_critical: number; open_high: number; open_total: number }> = {};
  if (targetIds.length > 0) {
    const { data: counts } = (await supabase
      .from('findings')
      .select('target_id, severity')
      .in('target_id', targetIds)
      .eq('status', 'open')) as unknown as {
      data: Array<{ target_id: string; severity: string }> | null;
    };
    for (const row of counts ?? []) {
      const bucket = (perTargetCounts[row.target_id] ??= {
        open_critical: 0,
        open_high: 0,
        open_total: 0,
      });
      bucket.open_total += 1;
      if (row.severity === 'critical') bucket.open_critical += 1;
      if (row.severity === 'high') bucket.open_high += 1;
    }
  }

  return NextResponse.json({
    project,
    targets: targets ?? [],
    per_target_counts: perTargetCounts,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const isUuid = UUID_RE.test(params.id);
  const baseQ = supabase.from('projects');
  const { data: row, error } = (await (isUuid
    ? baseQ.update(parsed.data as never).eq('id', params.id)
    : baseQ.update(parsed.data as never).eq('slug', params.id)
  )
    .select('id, name, slug, criticality, owner_user_id, tags, updated_at')
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `update failed: ${error.message}` },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }

  // Audit log — admin client so we always write regardless of RLS.
  const admin = createAdminClient();
  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (orgId) {
    await admin.from('audit_log').insert({
      org_id: orgId,
      user_id: user.id,
      action: 'project.updated',
      resource_type: 'project',
      resource_id: row.id,
      metadata: { fields: Object.keys(parsed.data) },
    } as never);
  }

  return NextResponse.json({ ok: true, project: row });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const isUuid = UUID_RE.test(params.id);
  const q = supabase.from('projects').update({ archived_at: new Date().toISOString() } as never);
  const { data, error } = (await (isUuid
    ? q.eq('id', params.id)
    : q.eq('slug', params.id)
  )
    .select('id')
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json(
      { error: `archive failed: ${error.message}` },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: 'project not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
