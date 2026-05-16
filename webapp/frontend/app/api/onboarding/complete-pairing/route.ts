import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Tier II #9 — wizard finishing step.
//
// POST /api/onboarding/complete-pairing
//   body: {
//     repo_url:           string,                 // https://github.com/owner/repo
//     repo_name:          string,                 // human-friendly target name
//     integration_id:     string,                 // github integration owning the OAuth token
//     prod_url?:          string | null,          // optional matched web target URL
//     prod_name?:         string | null,          // optional human name for the web target
//     suggested_scan_mode: 'quick'|'standard'|'deep',
//   }
//
// Creates one repository target (always) and optionally one
// web_application target paired to the same org. On success, stamps
// profiles.onboarding_state = 'completed' so the dialog stops
// rendering and returns the created target ids.
//
// We do it as two separate INSERTs rather than wrapping in an RPC
// because (a) targets has more validation that lives in zod (see
// /api/targets/route.ts), (b) the pair is "best effort" — if the
// web target insert fails we still want the repo target to land so
// the user has *something* to scan.

const Body = z.object({
  repo_url: z.string().url().max(500),
  repo_name: z.string().min(1).max(120),
  integration_id: z.string().uuid(),
  prod_url: z.string().url().max(500).nullable().optional(),
  prod_name: z.string().min(1).max(120).nullable().optional(),
  suggested_scan_mode: z.enum(['quick', 'standard', 'deep']).default('standard'),
});

interface CreatedTarget {
  id: string;
  type: string;
  value: string;
  warning?: string;
}

export async function POST(req: Request) {
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

  // Read org_id from JWT — same pattern as POST /api/targets.
  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const orgId = tok ? readJwtClaim(tok, 'org_id') : null;
  if (!orgId) {
    return NextResponse.json({ error: 'no org context' }, { status: 400 });
  }

  // Confirm the integration belongs to the user's org (RLS handles
  // this, but a clean 412 is friendlier than the generic FK error).
  const { data: integration } = await supabase
    .from('integrations')
    .select('id, org_id, type, status')
    .eq('id', parsed.data.integration_id)
    .single();
  if (!integration || integration.type !== 'github' || integration.status !== 'active') {
    return NextResponse.json(
      { error: 'integration not found or not an active github integration' },
      { status: 412 },
    );
  }

  const created: CreatedTarget[] = [];
  const admin = createAdminClient();

  // ---- Repository target ------------------------------------------
  const { data: repoTarget, error: repoErr } = (await supabase
    .from('targets')
    .insert({
      org_id: orgId,
      name: parsed.data.repo_name,
      type: 'repository',
      value: parsed.data.repo_url,
      description: 'Created via onboarding wizard',
      scan_frequency: 'manual',
      auto_discover: false,
      integration_id: parsed.data.integration_id,
      config: {},
      created_by: user.id,
    } as never)
    .select('id, type, value')
    .single()) as unknown as { data: CreatedTarget | null; error: { message: string } | null };

  if (repoErr || !repoTarget) {
    // 23505 = unique violation (target already exists for this org).
    // We treat that as a soft success — the wizard's job is to get the
    // user *to* a scan-able state, not to be picky about pre-existing
    // rows. Look up the existing row to return its id.
    if (repoErr?.message?.includes('duplicate')) {
      const { data: existing } = (await supabase
        .from('targets')
        .select('id, type, value')
        .eq('org_id', orgId)
        .eq('type', 'repository')
        .eq('value', parsed.data.repo_url)
        .maybeSingle()) as unknown as { data: CreatedTarget | null };
      if (existing) {
        created.push({ ...existing, warning: 'already existed' });
      }
    } else {
      return NextResponse.json(
        { error: `failed to create repo target: ${repoErr?.message ?? 'unknown'}` },
        { status: 500 },
      );
    }
  } else {
    created.push(repoTarget);
    await admin.from('audit_log').insert({
      org_id: orgId,
      user_id: user.id,
      action: 'target.create',
      resource_type: 'target',
      resource_id: repoTarget.id,
      metadata: { source: 'onboarding-wizard', type: 'repository' },
    } as never);
  }

  // ---- Web application target (optional) --------------------------
  if (parsed.data.prod_url && parsed.data.prod_name) {
    const { data: webTarget, error: webErr } = (await supabase
      .from('targets')
      .insert({
        org_id: orgId,
        name: parsed.data.prod_name,
        type: 'web_application',
        value: parsed.data.prod_url,
        description: 'Production URL paired with the repo (onboarding wizard)',
        scan_frequency: 'manual',
        auto_discover: false,
        integration_id: null,
        config: {},
        created_by: user.id,
      } as never)
      .select('id, type, value')
      .single()) as unknown as { data: CreatedTarget | null; error: { message: string } | null };

    if (webErr) {
      // Soft-fail — the repo target landed, so the wizard's primary
      // outcome is met. We surface the warning so the UI can show it.
      created.push({
        id: '',
        type: 'web_application',
        value: parsed.data.prod_url,
        warning: webErr.message,
      });
    } else if (webTarget) {
      created.push(webTarget);
      await admin.from('audit_log').insert({
        org_id: orgId,
        user_id: user.id,
        action: 'target.create',
        resource_type: 'target',
        resource_id: webTarget.id,
        metadata: { source: 'onboarding-wizard', type: 'web_application' },
      } as never);
    }
  }

  // ---- Stamp profile state ----------------------------------------
  await supabase
    .from('profiles')
    .update({
      onboarding_state: 'completed',
      onboarding_completed_at: new Date().toISOString(),
    } as never)
    .eq('id', user.id);

  // ---- Return the created targets + the suggested scan_mode so the
  //      dialog can deeplink straight to /scans/new pre-filled. ----
  return NextResponse.json({
    ok: true,
    targets: created,
    repo_target_id: created.find((t) => t.type === 'repository')?.id ?? null,
    web_target_id: created.find((t) => t.type === 'web_application')?.id ?? null,
    suggested_scan_mode: parsed.data.suggested_scan_mode,
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
