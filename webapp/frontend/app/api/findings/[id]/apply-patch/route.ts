import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseUnifiedDiff, applyEdit, DiffParseError, DiffApplyError } from '@/lib/diff';

// POST /api/findings/[id]/apply-patch
//
// Closes the find-fix loop: take the Patcher specialist's proposed
// diff for a finding, apply it through the org's GitHub integration,
// and open a PR. The user's "Apply as PR" button on the finding card
// is the only caller.
//
// Flow:
//   1. RLS-gated load of the finding + scan + target. We need:
//      - patch_diff           — the unified diff to apply
//      - patch_commit_message — the conventional-commit summary
//      - scans.target_id      — to resolve the repo
//      - targets.value        — must be a github.com URL
//      - scans.id             — needed by worker_decrypt_integration
//   2. Resolve the org's `github` integration (one row in
//      integrations where type='github' and status='active'). 412 if
//      none — the UI surfaces "Connect GitHub" in this case.
//   3. Decrypt the OAuth token via `worker_decrypt_integration` (the
//      RPC's permission model requires service-role + the scan_id to
//      belong to the integration's org — both true here).
//   4. Parse the diff, apply each file edit against the repo's current
//      contents fetched from GitHub. Bail with 422 + the per-file
//      reason if any hunk's context doesn't match (this is `git apply
//      --check` failing — typically because the codebase moved since
//      the scan ran).
//   5. Use the Git Data API to build a commit on a new branch:
//      blobs → tree → commit → ref create → PR open.
//   6. Stamp patch_pr_url + patch_applied_at on the finding row so
//      the UI shows "View PR" on revisit.
//
// All GitHub state changes are idempotent enough that a partial
// failure doesn't leave the repo in a half-applied state: branch
// creation is the first mutation, and we never amend an existing
// branch — a re-attempt opens a new branch with a new timestamp.

const GH_API = 'https://api.github.com';
const UA = 'tensorshield-webapp';

interface GitHubError {
  message?: string;
  status?: number;
  documentation_url?: string;
}

interface IntegrationSecret {
  access_token: string;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // 1. Load finding + scan + target. RLS gates org-membership.
  const { data: finding, error: findingErr } = await supabase
    .from('findings')
    .select(`
      id, org_id, scan_id, title, severity, cwe,
      patch_id, patch_diff, patch_commit_message, patch_status,
      patch_pr_url,
      scans!inner ( id, org_id, target_id ),
      targets ( id, type, value )
    `)
    .eq('id', params.id)
    .single<FindingJoin>();
  if (findingErr || !finding) {
    return NextResponse.json({ error: 'finding not found or no access' }, { status: 404 });
  }

  if (finding.patch_pr_url) {
    return NextResponse.json(
      {
        error: 'patch already applied',
        pr_url: finding.patch_pr_url,
        hint: 'Visit the existing PR or revert it before re-applying.',
      },
      { status: 409 },
    );
  }
  if (!finding.patch_diff || !finding.patch_commit_message) {
    return NextResponse.json(
      { error: 'finding has no proposed patch to apply' },
      { status: 400 },
    );
  }

  const target = finding.targets;
  if (!target || target.type !== 'repository') {
    return NextResponse.json(
      {
        error: 'patches can only be applied to repository targets',
        hint: 'This finding came from a non-repository scan (web_application / api / domain / ip / local_code). Apply manually instead.',
      },
      { status: 400 },
    );
  }
  const repoInfo = parseGitHubRepoUrl(target.value);
  if (!repoInfo) {
    return NextResponse.json(
      { error: 'target value is not a recognised github.com URL' },
      { status: 400 },
    );
  }

  // 2. Resolve org's GitHub integration. Pick the most-recently-created
  //    active one — the apply flow is a single-account assumption today;
  //    multi-account support is a follow-up.
  const { data: integration, error: integrationErr } = await supabase
    .from('integrations')
    .select('id, org_id, metadata, status')
    .eq('org_id', finding.org_id)
    .eq('type', 'github')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (integrationErr) {
    return NextResponse.json({ error: integrationErr.message }, { status: 500 });
  }
  if (!integration) {
    return NextResponse.json(
      {
        error: 'no_github_integration',
        hint: 'Connect a GitHub account in Settings → Integrations before applying patches.',
      },
      { status: 412 },
    );
  }

  // 3. Decrypt the integration's OAuth token. We use the worker decrypt
  //    RPC because it already enforces "integration belongs to scan's
  //    org" — same security boundary applies to user-driven applies.
  const admin = createAdminClient();
  const { data: secretPlain, error: decryptErr } = await admin.rpc(
    'worker_decrypt_integration',
    { p_scan_id: finding.scan_id, p_integration_id: integration.id } as never,
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
    return NextResponse.json(
      { error: 'integration token missing access_token' },
      { status: 500 },
    );
  }

  // 4. Parse the diff + fetch the current repo state + apply hunks.
  let edits;
  try {
    edits = parseUnifiedDiff(finding.patch_diff);
  } catch (e) {
    if (e instanceof DiffParseError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    throw e;
  }

  // Get the repo's default branch + its tip SHA. Every subsequent file
  // read happens at that ref so the diff applies against a consistent
  // snapshot — if main moves while we're applying, the resulting PR is
  // still based on the snapshot we saw.
  const repoRes = await ghFetch(`${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}`, token);
  if (!repoRes.ok) {
    return forwardGitHubError(repoRes, 'fetch repo');
  }
  const repoMeta = (await repoRes.json()) as { default_branch?: string };
  const baseBranch = repoMeta.default_branch ?? 'main';

  const refRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/ref/heads/${baseBranch}`,
    token,
  );
  if (!refRes.ok) {
    return forwardGitHubError(refRes, `resolve ref heads/${baseBranch}`);
  }
  const refJson = (await refRes.json()) as { object?: { sha?: string } };
  const baseSha = refJson.object?.sha;
  if (!baseSha) {
    return NextResponse.json(
      { error: 'github returned no SHA for the default branch' },
      { status: 502 },
    );
  }

  // Apply each file edit against the snapshot at baseSha.
  const blobUpdates: { path: string; content: string }[] = [];
  for (const edit of edits) {
    if (edit.isDeleted) {
      return NextResponse.json(
        {
          error: 'patch contains a file deletion',
          hint: 'Deletions aren\'t supported in the auto-apply flow today. Apply manually.',
        },
        { status: 422 },
      );
    }
    let originalContent = '';
    if (!edit.isNewFile) {
      const contentRes = await ghFetch(
        `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/contents/${encodeURIComponent(edit.path).replace(/%2F/g, '/')}?ref=${baseSha}`,
        token,
        { Accept: 'application/vnd.github.raw' },
      );
      if (contentRes.status === 404) {
        return NextResponse.json(
          {
            error: `file in patch not found in repo: ${edit.path}`,
            hint: 'The codebase may have moved since the scan ran. Re-scan and try again, or apply manually.',
          },
          { status: 422 },
        );
      }
      if (!contentRes.ok) {
        return forwardGitHubError(contentRes, `fetch contents/${edit.path}`);
      }
      originalContent = await contentRes.text();
    }
    try {
      const newContent = applyEdit(edit, originalContent);
      blobUpdates.push({ path: edit.path, content: newContent });
    } catch (e) {
      if (e instanceof DiffApplyError) {
        return NextResponse.json(
          {
            error: e.message,
            hint: 'The codebase has drifted from the snapshot the engine scanned. Re-scan to get a fresh patch, or apply manually.',
            path: e.path,
          },
          { status: 422 },
        );
      }
      throw e;
    }
  }

  // 5. Build the commit via Git Data API.
  //    a) Create one blob per modified file.
  const blobShas: { path: string; sha: string }[] = [];
  for (const update of blobUpdates) {
    const blobRes = await ghFetch(
      `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/blobs`,
      token,
      { 'Content-Type': 'application/json' },
      'POST',
      JSON.stringify({
        content: Buffer.from(update.content, 'utf-8').toString('base64'),
        encoding: 'base64',
      }),
    );
    if (!blobRes.ok) {
      return forwardGitHubError(blobRes, `create blob for ${update.path}`);
    }
    const { sha } = (await blobRes.json()) as { sha: string };
    blobShas.push({ path: update.path, sha });
  }

  //    b) Build a tree on top of the base commit's tree, replacing each
  //       modified path's blob. We use `base_tree` so unchanged files
  //       are inherited automatically.
  const baseCommitRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits/${baseSha}`,
    token,
  );
  if (!baseCommitRes.ok) {
    return forwardGitHubError(baseCommitRes, 'fetch base commit');
  }
  const baseCommit = (await baseCommitRes.json()) as { tree?: { sha?: string } };
  const baseTreeSha = baseCommit.tree?.sha;
  if (!baseTreeSha) {
    return NextResponse.json({ error: 'base commit missing tree SHA' }, { status: 502 });
  }

  const treeRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees`,
    token,
    { 'Content-Type': 'application/json' },
    'POST',
    JSON.stringify({
      base_tree: baseTreeSha,
      tree: blobShas.map((b) => ({
        path: b.path,
        mode: '100644',
        type: 'blob',
        sha: b.sha,
      })),
    }),
  );
  if (!treeRes.ok) {
    return forwardGitHubError(treeRes, 'create tree');
  }
  const { sha: treeSha } = (await treeRes.json()) as { sha: string };

  //    c) Commit.
  const commitRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits`,
    token,
    { 'Content-Type': 'application/json' },
    'POST',
    JSON.stringify({
      message: finding.patch_commit_message,
      tree: treeSha,
      parents: [baseSha],
    }),
  );
  if (!commitRes.ok) {
    return forwardGitHubError(commitRes, 'create commit');
  }
  const { sha: commitSha } = (await commitRes.json()) as { sha: string };

  //    d) Branch. Name carries the patch id + a timestamp so re-runs
  //       don't collide.
  const branchName = `tensorshield/${finding.patch_id ?? finding.id.slice(0, 8)}-${Date.now()}`;
  const branchRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/git/refs`,
    token,
    { 'Content-Type': 'application/json' },
    'POST',
    JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
  );
  if (!branchRes.ok) {
    return forwardGitHubError(branchRes, 'create branch');
  }

  //    e) Open the PR.
  const prBody = buildPrBody(finding);
  const prRes = await ghFetch(
    `${GH_API}/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
    token,
    { 'Content-Type': 'application/json' },
    'POST',
    JSON.stringify({
      title: finding.patch_commit_message,
      head: branchName,
      base: baseBranch,
      body: prBody,
    }),
  );
  if (!prRes.ok) {
    return forwardGitHubError(prRes, 'open PR');
  }
  const { html_url: prUrl, number: prNumber } = (await prRes.json()) as {
    html_url: string;
    number: number;
  };

  // 6. Stamp the PR URL onto the finding so the UI shows "View PR".
  const { error: updateErr } = await admin
    .from('findings')
    .update({
      patch_pr_url: prUrl,
      patch_applied_at: new Date().toISOString(),
      patch_status: 'applied',
    })
    .eq('id', finding.id);
  if (updateErr) {
    // The PR is open — return success but warn that the DB stamp failed
    // so the UI can re-fetch on next visit.
    return NextResponse.json(
      {
        pr_url: prUrl,
        pr_number: prNumber,
        warning: `PR opened but database update failed: ${updateErr.message}. Refresh to re-read.`,
      },
      { status: 200 },
    );
  }

  // Audit log — apply actions are user-attributed material changes,
  // belong in the trail next to the integration creation event.
  await admin.from('audit_log').insert({
    org_id: finding.org_id,
    user_id: user.id,
    action: 'finding.patch.apply',
    resource_type: 'finding',
    resource_id: finding.id,
    metadata: {
      pr_url: prUrl,
      pr_number: prNumber,
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      branch: branchName,
      files: blobUpdates.map((b) => b.path),
    },
  });

  return NextResponse.json({
    pr_url: prUrl,
    pr_number: prNumber,
    branch: branchName,
    files_changed: blobUpdates.length,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FindingJoin {
  id: string;
  org_id: string;
  scan_id: string;
  title: string | null;
  severity: string | null;
  cwe: string | null;
  patch_id: string | null;
  patch_diff: string | null;
  patch_commit_message: string | null;
  patch_status: string | null;
  patch_pr_url: string | null;
  scans: { id: string; org_id: string; target_id: string | null } | null;
  targets: { id: string; type: string; value: string } | null;
}

function parseGitHubRepoUrl(value: string): { owner: string; repo: string } | null {
  // Accept https://github.com/<owner>/<repo>, .git suffix optional.
  // Also accept git@github.com:<owner>/<repo>.git for completeness.
  const cleaned = value.trim();
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = cleaned.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

async function ghFetch(
  url: string,
  token: string,
  extraHeaders: Record<string, string> = {},
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: string,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      ...extraHeaders,
    },
    body,
  });
}

async function forwardGitHubError(res: Response, ctx: string) {
  let detail: GitHubError | string = '';
  try {
    detail = (await res.json()) as GitHubError;
  } catch {
    detail = await res.text().catch(() => '');
  }
  const message =
    typeof detail === 'object' && detail?.message
      ? `${ctx}: ${detail.message}`
      : `${ctx}: github returned ${res.status}`;
  return NextResponse.json({ error: message, github_status: res.status }, { status: 502 });
}

function buildPrBody(f: FindingJoin): string {
  const lines = [
    `Auto-generated by **TensorShield** from finding [\`${f.id.slice(0, 8)}\`](https://app.tensorshield.dev/findings/${f.id}).`,
    '',
    `> **${f.title ?? '(untitled finding)'}**`,
    '',
  ];
  const facts: string[] = [];
  if (f.severity) facts.push(`severity: \`${f.severity}\``);
  if (f.cwe) facts.push(`CWE: \`${f.cwe}\``);
  if (f.patch_id) facts.push(`patch: \`${f.patch_id}\``);
  if (facts.length) {
    lines.push(facts.join(' · '));
    lines.push('');
  }
  lines.push(
    '---',
    '',
    'This patch was proposed by the engine\'s Patcher specialist. Review the diff before merging — the wrapper applied it directly via the Git Data API without running tests.',
  );
  return lines.join('\n');
}
