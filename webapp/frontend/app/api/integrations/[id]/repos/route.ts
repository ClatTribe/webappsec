import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// GET /api/integrations/[id]/repos
//
// Phase B #3 — list the repositories the connected GitHub integration
// has access to. Powers the bulk repo importer on `/targets/new`:
//   1. User picks a connected GitHub integration.
//   2. We hit /user/repos with the integration's OAuth token.
//   3. Frontend shows a paginated multi-select.
//   4. POST to /api/targets in a loop to create the picked repos as
//      targets (linked to this integration).
//
// We deliberately don't paginate beyond GitHub's default page size
// (100) — multi-org accounts with thousands of repos can use the
// search/filter UI to narrow before importing rather than us trying
// to fetch them all. Keeps the round-trip predictable and gives the
// importer UX latitude to grow into a typeahead.

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  default_branch: string | null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // RLS-gated read of the integration. A successful select means the
  // caller is a member of the integration's org.
  const { data: integration } = await supabase
    .from('integrations')
    .select('id, org_id, type, status')
    .eq('id', params.id)
    .single();
  if (!integration) {
    return NextResponse.json({ error: 'integration not found' }, { status: 404 });
  }
  if (integration.type !== 'github') {
    return NextResponse.json(
      { error: 'repo listing is only supported for GitHub integrations today' },
      { status: 400 },
    );
  }
  if (integration.status !== 'active') {
    return NextResponse.json({ error: 'integration not active' }, { status: 400 });
  }

  // Decrypt the OAuth token via the service-role admin client. The
  // decrypt RPC requires a scan_id; since this is a user-driven
  // listing (no scan in scope), we use a custom path that calls
  // vault directly with org-membership check.
  const admin = createAdminClient();
  const { data: secretRow, error: secretErr } = await admin
    .from('integrations')
    .select('vault_secret_id')
    .eq('id', params.id)
    .single();
  if (secretErr || !secretRow?.vault_secret_id) {
    return NextResponse.json({ error: 'integration token unavailable' }, { status: 500 });
  }
  const { data: plaintext, error: vaultErr } = await admin
    .schema('vault')
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', secretRow.vault_secret_id)
    .single();
  if (vaultErr || !plaintext?.decrypted_secret) {
    return NextResponse.json(
      { error: `failed to decrypt integration: ${vaultErr?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }
  let token: string | null = null;
  try {
    const parsed = JSON.parse(plaintext.decrypted_secret as unknown as string);
    token = parsed.access_token ?? null;
  } catch {
    return NextResponse.json({ error: 'integration token is not JSON' }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json({ error: 'integration token missing access_token' }, { status: 500 });
  }

  // GitHub: /user/repos returns repos the authenticated user has
  // access to (own + collaborator + org-member). 100 per page is
  // the max; sort by pushed so the freshest repos surface first.
  const ghRes = await fetch(
    'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'tensorshield-webapp',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!ghRes.ok) {
    const body = await ghRes.text().catch(() => '');
    return NextResponse.json(
      { error: `github returned ${ghRes.status}: ${body.slice(0, 300)}` },
      { status: 502 },
    );
  }
  const repos = (await ghRes.json()) as GhRepo[];

  // Slim the payload — we don't need every field on the wire.
  const slim = repos
    .filter((r) => !r.archived) // archived repos can't reasonably be scanned
    .map((r) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description,
      private: r.private,
      fork: r.fork,
      pushed_at: r.pushed_at,
      default_branch: r.default_branch,
    }));

  // Cross-check against existing targets so the UI can pre-mark
  // already-imported repos.
  const { data: existingTargets } = await supabase
    .from('targets')
    .select('value')
    .eq('org_id', integration.org_id)
    .eq('type', 'repository');
  const imported = new Set(
    (existingTargets ?? [])
      .map((t) => (typeof t.value === 'string' ? normalizeRepoUrl(t.value) : null))
      .filter((s): s is string => !!s),
  );

  return NextResponse.json({
    repos: slim.map((r) => ({ ...r, already_imported: imported.has(normalizeRepoUrl(r.html_url)) })),
    count: slim.length,
  });
}

function normalizeRepoUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
}
