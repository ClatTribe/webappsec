import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

// POST   /api/target-templates/[id]/targets  { target_ids: [...] }  attach in bulk
// DELETE /api/target-templates/[id]/targets  { target_ids: [...] }  detach
//
// Wraps the SECURITY DEFINER attach/detach RPCs from migration 082.

export const dynamic = 'force-dynamic';

const Body = z.object({
  target_ids: z.array(z.string().uuid()).min(1).max(500),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTemplateId(
  supabase: ReturnType<typeof createClient>,
  param: string,
): Promise<string | null> {
  if (UUID_RE.test(param)) return param;
  const { data } = await supabase
    .from('target_templates')
    .select('id')
    .eq('slug', param)
    .is('archived_at', null)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
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

  const templateId = await resolveTemplateId(supabase, params.id);
  if (!templateId) {
    return NextResponse.json({ error: 'template not found' }, { status: 404 });
  }

  const { data, error } = (await supabase.rpc('attach_template_to_targets', {
    p_template_id: templateId,
    p_target_ids: parsed.data.target_ids,
  })) as unknown as { data: number | null; error: { message: string } | null };

  if (error) {
    return NextResponse.json(
      { error: `attach failed: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, attached: data ?? 0 });
}

export async function DELETE(req: Request, { params: _params }: { params: { id: string } }) {
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

  const { data, error } = (await supabase.rpc('detach_template_from_targets', {
    p_target_ids: parsed.data.target_ids,
  })) as unknown as { data: number | null; error: { message: string } | null };

  if (error) {
    return NextResponse.json(
      { error: `detach failed: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, detached: data ?? 0 });
}
