import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashRuleYaml, validateRuleYaml } from '@/lib/custom-rules';

// Custom rule — update + soft-delete.
//
//   PATCH  /api/custom-rules/[id]   partial update
//   DELETE /api/custom-rules/[id]   soft-delete (archived_at = now)

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2048).optional().nullable(),
  language: z.string().min(1).max(50).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  cwe: z.string().max(50).optional().nullable(),
  rule_yaml: z.string().min(10).max(65536).optional(),
  enabled: z.boolean().optional(),
});

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

  // If rule_yaml changes, re-validate + re-hash.
  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.description !== undefined) update.description = parsed.data.description;
  if (parsed.data.language !== undefined) update.language = parsed.data.language.toLowerCase();
  if (parsed.data.severity !== undefined) update.severity = parsed.data.severity;
  if (parsed.data.cwe !== undefined) update.cwe = parsed.data.cwe;
  if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
  if (parsed.data.rule_yaml !== undefined) {
    const v = validateRuleYaml(parsed.data.rule_yaml);
    if (!v.ok) {
      return NextResponse.json(
        { error: `rule_yaml validation: ${v.error}` },
        { status: 400 },
      );
    }
    update.rule_yaml = parsed.data.rule_yaml;
    update.rule_hash = hashRuleYaml(parsed.data.rule_yaml);
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { data: row, error } = (await supabase
    .from('custom_rules')
    .update(update as never)
    .eq('id', params.id)
    .select('id, org_id, name, language, severity, enabled')
    .single()) as unknown as {
    data: { id: string; org_id: string; name: string; language: string; severity: string; enabled: boolean } | null;
    error: { message: string } | null;
  };

  if (error || !row) {
    return NextResponse.json(
      { error: error?.message ?? 'rule not found' },
      { status: 404 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: row.org_id,
    user_id: user.id,
    action: 'custom_rule.update',
    resource_type: 'custom_rule',
    resource_id: row.id,
    metadata: { fields_changed: Object.keys(update) },
  } as never);

  return NextResponse.json({ ok: true, rule: row });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from('custom_rules')
    .select('id, org_id, name, archived_at')
    .eq('id', params.id)
    .single();
  if (!existing) {
    return NextResponse.json({ error: 'rule not found' }, { status: 404 });
  }
  if (existing.archived_at) {
    return NextResponse.json({ ok: true, already_archived: true });
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('custom_rules')
    .update({ archived_at: nowIso, archived_by: user.id, enabled: false } as never)
    .eq('id', params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: existing.org_id,
    user_id: user.id,
    action: 'custom_rule.archive',
    resource_type: 'custom_rule',
    resource_id: params.id,
    metadata: { name: existing.name },
  } as never);

  return NextResponse.json({ ok: true, archived_at: nowIso });
}
