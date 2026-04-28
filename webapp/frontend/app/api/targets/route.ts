import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Body = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['local_code', 'repository', 'web_application', 'domain', 'ip_address']),
  value: z.string().min(1).max(500),
  description: z.string().max(1000).optional(),
  scan_frequency: z.enum(['manual', 'daily', 'weekly', 'monthly']).default('manual'),
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

  const { data, error } = await supabase
    .from('targets')
    .insert({
      org_id: orgId,
      name: parsed.data.name,
      type: parsed.data.type,
      value: parsed.data.value,
      description: parsed.data.description ?? null,
      scan_frequency: parsed.data.scan_frequency,
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
