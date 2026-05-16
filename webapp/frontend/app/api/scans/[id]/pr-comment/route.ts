import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ghFetch, ghJson } from '@/lib/github';
import { composePrComment, STICKY_MARKER } from '@/lib/pr-comment';
import type { Finding } from '@/lib/supabase/types';

// Tier II #7 — POST /api/scans/[id]/pr-comment
//
// Posts the sticky scan-summary comment on the PR this scan was
// triggered for. Two auth paths:
//
//   1. **User-context** — the wrapper UI exposes a "Re-post PR comment"
//      action. Authenticated user must have visibility on the scan.
//   2. **Worker post-finalize** — the worker fires this route after
//      finish_scan() so the PR gets the comment exactly once per
//      scan, with no client-side dependency. Authenticated via the
//      shared secret in tensorshield_settings.worker_internal_secret
//      (X-Worker-Secret header).
//
// Idempotency: we sticky-update via PATCH on the saved comment id.
// First call POSTs and stores comment_id; subsequent calls PATCH
// the same comment. If the saved comment has been deleted on
// GitHub's side, we fall back to scanning the PR's comment list
// for our STICKY_MARKER and PATCHing that, or finally POST a new
// one.

const GH_API = 'https://api.github.com';

interface IntegrationSecret {
  access_token: string;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
}

interface PostBody {
  // Optional override — if a re-run wants to skip the cache and
  // force re-locate the sticky comment on GitHub's side.
  force_refresh_marker?: boolean;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // ---- 1. Auth: user-context OR worker secret ----------------------
  const workerSecret = req.headers.get('x-worker-secret');
  const admin = createAdminClient();
  let authedAs: 'user' | 'worker';

  if (workerSecret) {
    const { data: settings } = await admin
      .from('tensorshield_settings')
      .select('worker_internal_secret')
      .eq('id', 1)
      .single();
    const stored = (settings as { worker_internal_secret?: string } | null)?.worker_internal_secret;
    if (!stored || !constantTimeEq(workerSecret, stored)) {
      return NextResponse.json({ error: 'invalid worker secret' }, { status: 401 });
    }
    authedAs = 'worker';
  } else {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    authedAs = 'user';
  }

  const body: PostBody = await req.json().catch(() => ({}));

  // ---- 2. Load scan + findings (RLS for user, admin for worker) -----
  const db = authedAs === 'worker' ? admin : createClient();
  const { data: scan, error: scanErr } = await db
    .from('scans')
    .select(
      `
      id, org_id, run_name, status, created_at, scan_mode, diff_base,
      github_owner, github_repo, github_pull_request_number,
      github_head_sha, pr_comment_id, pr_comment_url,
      organizations:org_id ( slug ),
      scan_integrations ( integration_id )
      `,
    )
    .eq('id', params.id)
    .single();

  if (scanErr || !scan) {
    return NextResponse.json(
      { error: 'scan not found or no access' },
      { status: 404 },
    );
  }

  if (
    !scan.github_owner ||
    !scan.github_repo ||
    !scan.github_pull_request_number
  ) {
    return NextResponse.json(
      {
        error: 'scan has no PR context',
        hint: 'PR comments can only be posted for scans created from a GitHub PR webhook.',
      },
      { status: 412 },
    );
  }

  const { data: findings, error: findingsErr } = await db
    .from('findings')
    .select(
      'id, title, severity, vuln_id, endpoint, cwe, cve, patch_id, patch_status, patch_pr_url, patch_diff',
    )
    .eq('scan_id', scan.id);

  if (findingsErr) {
    return NextResponse.json({ error: findingsErr.message }, { status: 500 });
  }

  // ---- 3. Resolve GitHub integration + decrypt token ---------------
  // Webhook-driven scans get a scan_integrations row pointing at the
  // integration that owned the webhook delivery (see webhooks/github
  // route). We pick the first github-type integration from that link
  // set, falling back to the org's most-recent active github
  // integration for manually-kicked scans.
  const linkedIntegrationIds = Array.isArray(scan.scan_integrations)
    ? scan.scan_integrations
        .map((r) => (r as { integration_id?: string }).integration_id)
        .filter((v): v is string => typeof v === 'string')
    : [];
  let integrationIdToUse: string | null = null;
  if (linkedIntegrationIds.length > 0) {
    const { data: linkedRows } = await db
      .from('integrations')
      .select('id, type')
      .in('id', linkedIntegrationIds)
      .eq('type', 'github')
      .eq('status', 'active');
    integrationIdToUse = (linkedRows ?? [])[0]?.id ?? null;
  }
  if (!integrationIdToUse) {
    // Fallback: pick the org's most-recent active github integration.
    const { data: fallback } = await db
      .from('integrations')
      .select('id')
      .eq('org_id', scan.org_id)
      .eq('type', 'github')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    integrationIdToUse = (fallback as { id?: string } | null)?.id ?? null;
  }
  if (!integrationIdToUse) {
    return NextResponse.json(
      { error: 'no GitHub integration available for this org' },
      { status: 412 },
    );
  }

  const { data: secretPlain, error: decryptErr } = await admin.rpc(
    'worker_decrypt_integration',
    { p_scan_id: scan.id, p_integration_id: integrationIdToUse } as never,
  );
  if (decryptErr || !secretPlain) {
    return NextResponse.json(
      { error: `failed to decrypt integration token: ${decryptErr?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  let secret: IntegrationSecret;
  try {
    secret = JSON.parse(secretPlain as unknown as string);
  } catch {
    return NextResponse.json(
      { error: 'integration token payload is not valid JSON' },
      { status: 500 },
    );
  }
  const token = secret.access_token;
  if (!token) {
    return NextResponse.json({ error: 'integration missing access_token' }, { status: 500 });
  }

  // ---- 4. Compose the comment body --------------------------------
  const orgSlug =
    (scan.organizations as { slug?: string } | { slug?: string }[] | null) &&
    !Array.isArray(scan.organizations)
      ? (scan.organizations as { slug?: string }).slug
      : Array.isArray(scan.organizations)
        ? scan.organizations[0]?.slug
        : undefined;

  const commentBody = composePrComment({
    scan: {
      id: scan.id,
      org_id: scan.org_id,
      run_name: scan.run_name,
      status: scan.status,
      created_at: scan.created_at,
      scan_mode: scan.scan_mode,
      diff_base: scan.diff_base,
      github_owner: scan.github_owner,
      github_repo: scan.github_repo,
      github_pull_request_number: scan.github_pull_request_number,
      github_head_sha: scan.github_head_sha,
    },
    findings: (findings ?? []) as unknown as Finding[],
    orgSlug,
  });

  // ---- 5. Resolve which comment id to PATCH (or POST fresh) ---------
  const owner = scan.github_owner;
  const repo = scan.github_repo;
  const prNumber = scan.github_pull_request_number;
  let commentId: number | null =
    !body.force_refresh_marker && typeof scan.pr_comment_id === 'number'
      ? scan.pr_comment_id
      : null;

  // If we don't have one cached, scan the PR's comments for our marker.
  // Caps at 100 comments; for the rare PR with > 100 we'll fall through
  // and POST a fresh comment (and update the marker for next time).
  if (commentId === null) {
    const list = await ghJson<Array<{ id: number; body: string }>>(
      `${GH_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      token,
    );
    if (list.ok) {
      const existing = list.data.find((c) => typeof c.body === 'string' && c.body.includes(STICKY_MARKER));
      if (existing) commentId = existing.id;
    }
  }

  // ---- 6. POST new OR PATCH existing -------------------------------
  let postedCommentId: number;
  let postedCommentUrl: string;
  let isUpdate = false;

  if (commentId !== null) {
    const patchRes = await ghJson<{ id: number; html_url: string }>(
      `${GH_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
      token,
      { method: 'PATCH', body: { body: commentBody } },
    );
    if (!patchRes.ok) {
      // Most common cause: comment was deleted. Fall through to POST
      // a fresh one rather than failing the caller.
      if (patchRes.status === 404) {
        commentId = null;
      } else {
        return NextResponse.json(
          { error: `github PATCH failed: ${patchRes.error}` },
          { status: 502 },
        );
      }
    } else {
      postedCommentId = patchRes.data.id;
      postedCommentUrl = patchRes.data.html_url;
      isUpdate = true;
    }
  }

  if (commentId === null) {
    const postRes = await ghJson<{ id: number; html_url: string }>(
      `${GH_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      token,
      { method: 'POST', body: { body: commentBody } },
    );
    if (!postRes.ok) {
      return NextResponse.json(
        { error: `github POST failed: ${postRes.error}` },
        { status: 502 },
      );
    }
    postedCommentId = postRes.data.id;
    postedCommentUrl = postRes.data.html_url;
  }

  // ---- 7. Persist sticky-comment tracking -------------------------
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    pr_comment_id: postedCommentId!,
    pr_comment_url: postedCommentUrl!,
    pr_comment_updated_at: nowIso,
  };
  if (!isUpdate) update.pr_comment_posted_at = nowIso;

  await admin
    .from('scans')
    .update(update as never)
    .eq('id', scan.id);

  return NextResponse.json({
    ok: true,
    action: isUpdate ? 'updated' : 'created',
    comment_id: postedCommentId!,
    comment_url: postedCommentUrl!,
    findings_total: (findings ?? []).length,
  });
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
