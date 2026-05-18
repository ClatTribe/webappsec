import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// GET    /api/target-templates/[id]   single + per-target listing
// PATCH  /api/target-templates/[id]   partial update
// DELETE /api/target-templates/[id]   soft archive
//
// Param can be UUID or per-org slug.

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2048).nullable().optional(),
    asset_type: z
      .enum([
        'local_code',
        'repository',
        'web_application',
        'domain',
        'ip_address',
        'api',
        'container_image',
        'cloud_account',
      ])
      .nullable()
      .optional(),
    config: z.record(z.unknown()).optional(),
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
  const q = supabase
    .from('target_templates')
    .select('id, name, slug, description, asset_type, config, tags, created_at, updated_at')
    .is('archived_at', null);
  const { data: template } = (await (isUuid
    ? q.eq('id', params.id)
    : q.eq('slug', params.id)
  ).maybeSingle()) as unknown as { data: { id: string } | null };

  if (!template) {
    return NextResponse.json({ error: 'template not found' }, { status: 404 });
  }

  const { data: attachedTargets } = await supabase
    .from('targets')
    .select('id, name, type, value, status, last_scan_at, project_id')
    .eq('template_id', template.id)
    .order('name');

  return NextResponse.json({ template, targets: attachedTargets ?? [] });
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
  const baseQ = supabase.from('target_templates');
  const { data: row, error } = (await (isUuid
    ? baseQ.update(parsed.data as never).eq('id', params.id)
    : baseQ.update(parsed.data as never).eq('slug', params.id)
  )
    .select('id, name, slug, asset_type, config, tags, updated_at')
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
    return NextResponse.json({ error: 'template not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, template: row });
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
  const q = supabase
    .from('target_templates')
    .update({ archived_at: new Date().toISOString() } as never);
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
    return NextResponse.json({ error: 'template not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
