import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ghFetch } from '@/lib/github';
import { detectStack, FILES_TO_INSPECT } from '@/lib/stack-detection';

// Tier II #9 — onboarding wizard / repo inspector.
//
// POST /api/onboarding/inspect-repo
//   body: { integration_id, owner, repo, ref? }
//
// For one repo, fetch a curated set of manifest files via the GitHub
// Contents API and run our pure detection analyzer against the result.
// Returns a structured DetectedStack + the list of files we successfully
// pulled (for the "we looked at X" UX in the dialog).
//
// We're deliberately *parallel-fetching* the manifest list — for a
// typical repo only 4-6 of these files exist, so each batch returns
// 404 for the rest. Hitting GitHub's 5k/hour authenticated rate limit
// with 35 fetches per inspection isn't a concern for the onboarding
// case (one wizard run per user).
//
// Edge case: GitHub returns 403 with "API rate limit exceeded" rather
// than 429 — we surface that distinctly so the dialog can show
// "rate-limited, try again in a minute" rather than a generic 500.

const GH_API = 'https://api.github.com';
const MAX_FILE_BYTES = 64 * 1024; // 64 KB cap per file — manifests are tiny

interface InspectBody {
  integration_id: string;
  owner: string;
  repo: string;
  /** Optional git ref — defaults to repo's default branch. We pull
   *  the default if omitted (same pattern as apply-patch). */
  ref?: string;
}

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Partial<InspectBody>;
  if (!body.integration_id || !body.owner || !body.repo) {
    return NextResponse.json(
      { error: 'integration_id, owner, repo are required' },
      { status: 400 },
    );
  }

  // ---- 1. RLS-gated integration read --------------------------------
  const { data: integration } = await supabase
    .from('integrations')
    .select('id, org_id, type, status')
    .eq('id', body.integration_id)
    .single();
  if (!integration) {
    return NextResponse.json({ error: 'integration not found' }, { status: 404 });
  }
  if (integration.type !== 'github' || integration.status !== 'active') {
    return NextResponse.json(
      { error: 'only active github integrations supported' },
      { status: 400 },
    );
  }

  // ---- 2. Decrypt the OAuth token via vault -------------------------
  // Same pattern as list-repos route (Phase B #3) — direct vault read
  // because there is no scan_id yet.
  const admin = createAdminClient();
  const { data: secretRow } = (await admin
    .from('integrations')
    .select('vault_secret_id')
    .eq('id', body.integration_id)
    .single()) as unknown as { data: { vault_secret_id: string } | null };
  if (!secretRow?.vault_secret_id) {
    return NextResponse.json({ error: 'integration token unavailable' }, { status: 500 });
  }
  const { data: plaintext } = (await (admin as unknown as { schema: (s: string) => ReturnType<typeof admin.from> }).schema('vault')
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', secretRow.vault_secret_id)
    .single()) as unknown as { data: { decrypted_secret: string } | null };
  if (!plaintext?.decrypted_secret) {
    return NextResponse.json(
      { error: 'failed to decrypt integration token' },
      { status: 500 },
    );
  }
  let token: string | null = null;
  try {
    const parsed = JSON.parse(plaintext.decrypted_secret) as { access_token?: string };
    token = parsed.access_token ?? null;
  } catch {
    return NextResponse.json({ error: 'integration token is not JSON' }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ error: 'integration missing access_token' }, { status: 500 });
  }

  // ---- 3. Resolve default branch if no ref supplied -----------------
  let ref = body.ref ?? '';
  if (!ref) {
    const repoMetaRes = await ghFetch(`${GH_API}/repos/${body.owner}/${body.repo}`, token);
    if (!repoMetaRes.ok) {
      if (repoMetaRes.status === 403) {
        return NextResponse.json(
          { error: 'github rate-limited — please try again in a minute' },
          { status: 429 },
        );
      }
      return NextResponse.json(
        { error: `repo metadata fetch failed (${repoMetaRes.status})` },
        { status: 502 },
      );
    }
    const meta = (await repoMetaRes.json()) as { default_branch?: string };
    ref = meta.default_branch ?? 'main';
  }

  // ---- 4. Parallel-fetch the manifest set ---------------------------
  const fetchResults = await Promise.all(
    FILES_TO_INSPECT.map((path) => fetchFile(token!, body.owner!, body.repo!, path, ref)),
  );

  const files: Record<string, string> = {};
  for (const r of fetchResults) {
    if (r.ok && r.content !== null) {
      files[r.path] = r.content;
    }
  }

  // ---- 5. Run pure detection ---------------------------------------
  const stack = detectStack(files);

  return NextResponse.json({
    ok: true,
    owner: body.owner,
    repo: body.repo,
    ref,
    files_inspected: Object.keys(files).sort(),
    stack,
  });
}

interface FileFetchResult {
  path: string;
  ok: boolean;
  content: string | null;
}

async function fetchFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<FileFetchResult> {
  // GitHub Contents API returns base64-encoded content with a small
  // wrapper. raw.githubusercontent.com would be one less hop but
  // requires the file to be public — the Contents API works for
  // both public and private repos with one OAuth token.
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await ghFetch(url, token);
  if (res.status === 404) {
    return { path, ok: false, content: null };
  }
  if (!res.ok) {
    return { path, ok: false, content: null };
  }
  const body = (await res.json()) as {
    encoding?: string;
    content?: string;
    size?: number;
  };
  if (typeof body.size === 'number' && body.size > MAX_FILE_BYTES) {
    return { path, ok: false, content: null };
  }
  if (body.encoding === 'base64' && typeof body.content === 'string') {
    try {
      // The Contents API base64 wraps lines at 60 chars — atob doesn't
      // care, but Buffer is faster + handles binary cleanly.
      const decoded = Buffer.from(body.content, 'base64').toString('utf8');
      return { path, ok: true, content: decoded };
    } catch {
      return { path, ok: false, content: null };
    }
  }
  return { path, ok: false, content: null };
}
