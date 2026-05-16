import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { configSchemaFor, type TargetType } from '@/lib/target-config';

const Body = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['local_code', 'repository', 'web_application', 'api', 'domain', 'ip_address']),
  value: z.string().min(1).max(500),
  description: z.string().max(1000).optional(),
  scan_frequency: z.enum(['manual', 'daily', 'weekly', 'monthly']).default('manual'),
  // Opt-in subdomain enumeration via crt.sh. Only honoured for domain
  // targets; ignored for everything else. Defaults to false — explicit
  // opt-in matches the principle of least surprise.
  auto_discover: z.boolean().default(false),
  // Per-target-type configuration blob. Validated *after* `type` is parsed
  // because the shape is discriminated on it (zod can't do field-dependent
  // discrimination natively). Default: empty object.
  config: z.record(z.string(), z.unknown()).default({}),
  // Phase A / migration 061 — repository targets can be bound to a
  // GitHub / GitLab / Bitbucket integration so the worker clones with
  // that integration's OAuth token. Only honoured for repo targets;
  // silently dropped for other types.
  integration_id: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) return NextResponse.json({ error: 'no org context' }, { status: 400 });

  // Validate the per-type config shape now that we know the type. zod can
  // do `discriminatedUnion` for tagged unions but our discriminator (type)
  // lives outside the config, so a manual second-pass parse is cleaner.
  const cfgParse = configSchemaFor(parsed.data.type as TargetType).safeParse(
    parsed.data.config,
  );
  if (!cfgParse.success) {
    return NextResponse.json(
      { error: 'invalid config for target type', details: cfgParse.error.format() },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('targets')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      type: parsed.data.type,
      value: parsed.data.value,
      description: parsed.data.description ?? null,
      scan_frequency: parsed.data.scan_frequency,
      // The trigger gates on type='domain' AND auto_discover=true, but we
      // also force-clear it here for non-domain types so a malformed UI can't
      // accidentally store auto_discover=true on, say, an IP address.
      auto_discover: parsed.data.type === 'domain' ? parsed.data.auto_discover : false,
      // Phase A — bind to integration only on repository targets.
      integration_id:
        parsed.data.type === 'repository' ? parsed.data.integration_id ?? null : null,
      config: cfgParse.data,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from('audit_log').insert({
    org_id: orgId,
    user_id: user.id,
    action: 'target.create',
    resource_type: 'target',
    resource_id: data.id,
    metadata: { name: parsed.data.name, type: parsed.data.type },
  });

  return NextResponse.json({ id: data.id });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
