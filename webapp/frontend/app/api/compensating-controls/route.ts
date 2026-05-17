import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #13 — compensating controls CRUD.
//
//   GET  /api/compensating-controls          list active rows
//        ?framework=soc_2                    optional framework filter
//   POST /api/compensating-controls          create
//        body: { framework, control_id, title, rationale,
//                evidence_links?, expires_at? }
//
// Revocation lives at /api/compensating-controls/[id] (DELETE).
//
// Both routes are user-context; RLS enforces org boundary +
// member-role check on writes.

const PostBody = z.object({
  framework: z.string().min(1).max(50),
  control_id: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(8192),
  evidence_links: z.array(z.string().url().max(2048)).max(20).default([]),
  expires_at: z.string().datetime().nullable().optional(),
});

export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const framework = url.searchParams.get('framework');

  const { data, error } = await supabase.rpc('compensating_controls_active', {
    p_framework: framework ?? null,
  } as never);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ controls: data ?? [] });
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

  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  const { data: row, error } = (await supabase
    .from('compensating_controls')
    .insert({
      org_id: orgId,
      framework: parsed.data.framework,
      control_id: parsed.data.control_id,
      title: parsed.data.title,
      rationale: parsed.data.rationale,
      evidence_links: parsed.data.evidence_links,
      expires_at: parsed.data.expires_at ?? null,
      created_by: user.id,
    } as never)
    .select(
      'id, framework, control_id, title, rationale, evidence_links, effective_from, expires_at, created_at',
    )
    .single()) as unknown as {
    data: {
      id: string;
      framework: string;
      control_id: string;
      title: string;
      rationale: string;
      evidence_links: string[];
      effective_from: string;
      expires_at: string | null;
      created_at: string;
    } | null;
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
    action: 'compensating_control.create',
    resource_type: 'compensating_control',
    resource_id: row.id,
    metadata: {
      framework: row.framework,
      control_id: row.control_id,
      expires_at: row.expires_at,
    },
  } as never);

  return NextResponse.json({ ok: true, control: row });
}

function readJwtClaim(token: string, claim: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload[claim] ?? null;
  } catch {
    return null;
  }
}
