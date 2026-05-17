import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashRuleYaml, validateRuleYaml } from '@/lib/custom-rules';

// Custom rule library — list + create.
//
//   GET  /api/custom-rules                  list active rules in caller's org
//   POST /api/custom-rules  { name, ... }   create a new rule

const PostBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2048).optional().nullable(),
  language: z.string().min(1).max(50),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
  cwe: z.string().max(50).optional().nullable(),
  rule_yaml: z.string().min(10).max(65536),
  enabled: z.boolean().default(true),
});

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('custom_rules')
    .select(
      'id, name, description, language, severity, cwe, enabled, rule_hash, created_at, updated_at, last_used_at, archived_at',
    )
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rules: data ?? [] });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const validation = validateRuleYaml(parsed.data.rule_yaml);
  if (!validation.ok) {
    return NextResponse.json(
      { error: `rule_yaml validation: ${validation.error}` },
      { status: 400 },
    );
  }

  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  const hash = hashRuleYaml(parsed.data.rule_yaml);

  const { data: row, error } = (await supabase
    .from('custom_rules')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      language: parsed.data.language.toLowerCase(),
      severity: parsed.data.severity,
      cwe: parsed.data.cwe ?? null,
      rule_yaml: parsed.data.rule_yaml,
      rule_hash: hash,
      enabled: parsed.data.enabled,
      created_by: user.id,
    } as never)
    .select(
      'id, name, description, language, severity, cwe, enabled, rule_hash, created_at',
    )
    .single()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };

  if (error || !row) {
    return NextResponse.json(
      { error: `failed to create: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'custom_rule.create',
    resource_type: 'custom_rule',
    resource_id: row.id,
    metadata: {
      name: parsed.data.name,
      language: parsed.data.language,
      severity: parsed.data.severity,
      rule_count: validation.rule_count,
    },
  } as never);

  return NextResponse.json({
    ok: true,
    rule: row,
    rule_count: validation.rule_count,
  });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
