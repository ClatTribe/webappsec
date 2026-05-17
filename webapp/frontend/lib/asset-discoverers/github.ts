// GitHub repository discoverer.
//
// Connects-once-discovers-N for the GitHub integration. Lists every
// repo the integration's OAuth token has access to (owner +
// collaborator + org-member), filters out archived/fork/empty repos
// by default, and proposes each as a `repository` target.
//
// Why this matters: an org with 200 repos shouldn't fill 200 forms.
// They connect GitHub once, hit "discover", review the inferred list,
// bulk-approve. The same 200 repos then continuously scan on the
// suggested cadence.
//
// Confidence heuristic:
//   - high   : non-fork, non-archived, pushed in the last 30 days
//   - medium : default
//   - low    : forks, repos with no recent activity (180d+)
//
// We deliberately don't paginate past the first 100 repos per call —
// GitHub's max page is 100, and 100-repo orgs are common but
// 1000-repo orgs are rare enough that the explicit Link-header
// pagination loop is worth the small added complexity.

import { ghJson } from '@/lib/github';
import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

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
  language: string | null;
  size: number;
}

const PER_PAGE = 100;
const MAX_PAGES = 10; // 1000 repos cap — beyond that, customer should narrow

export const githubReposDiscoverer: DiscovererDefinition = {
  id: 'github_repos',
  provider: 'github',
  display_name: 'GitHub repositories',
  description:
    'Enumerates repositories the connected GitHub integration has ' +
    'access to (owner / collaborator / org-member) and proposes each ' +
    'as a repository target. Archived repos are filtered out; forks ' +
    'and dormant repos surface with low confidence.',
  integration_type: 'github',
  produces: ['repository'],
  default_frequency_minutes: 1440, // 24h
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as { access_token?: string };
    const token = creds.access_token;
    if (!token) {
      throw new Error('github integration is missing access_token in vault');
    }

    // Walk paginated /user/repos until we hit MAX_PAGES or a short
    // page (signal there are no more). The endpoint is the same one
    // /api/integrations/[id]/repos uses today — we keep behaviour
    // consistent so existing customers don't see a sudden inventory
    // diff between the importer and the new discoverer.
    const allRepos: GhRepo[] = [];
    let partialError: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://api.github.com/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
      const res = await ghJson<GhRepo[]>(url, token);
      if (!res.ok) {
        // First-page failure is fatal; later-page failures are
        // partial — we keep what we have.
        if (page === 1) {
          throw new Error(`github /user/repos page 1 failed: ${res.status} ${res.error}`);
        }
        partialError = `github pagination stopped at page ${page}: ${res.status} ${res.error}`;
        break;
      }
      allRepos.push(...res.data);
      if (res.data.length < PER_PAGE) break;
    }

    if (allRepos.length === MAX_PAGES * PER_PAGE) {
      partialError =
        `${allRepos.length}+ repos in this org — discoverer paginated up to its ${MAX_PAGES * PER_PAGE} cap. ` +
        'Connect a more narrowly-scoped GitHub app or filter by topic in v2.';
    }

    const now = Date.now();
    const ageDaysOf = (iso: string | null): number | null => {
      if (!iso) return null;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return null;
      return Math.floor((now - t) / (24 * 60 * 60 * 1000));
    };

    const assets: DiscoveredAsset[] = allRepos
      .filter((r) => !r.archived) // archived can't reasonably be scanned
      .filter((r) => r.size > 0) // empty repos have nothing to scan
      .map((r) => {
        const age = ageDaysOf(r.pushed_at);
        const confidence: DiscoveredAsset['confidence'] = r.fork
          ? 'low'
          : age !== null && age > 180
            ? 'low'
            : age !== null && age <= 30
              ? 'high'
              : 'medium';
        return {
          asset_type: 'repository' as const,
          canonical_id: `github:${r.full_name}`,
          display_name: r.full_name,
          attributes: {
            value: r.html_url,
            description: r.description ?? undefined,
            upstream_url: r.html_url,
            tags: [
              r.private ? 'private' : 'public',
              ...(r.fork ? ['fork'] : []),
              ...(r.language ? [`lang:${r.language.toLowerCase()}`] : []),
            ],
            language: r.language,
            default_branch: r.default_branch,
            last_active: r.pushed_at,
            age_days: age,
            integration_id: ctx.integrationId,
          },
          // Default scan config: weekly cadence for high-confidence,
          // monthly for low-confidence. Standard scan mode keeps the
          // first scan cheap; customer can deepen per asset later.
          suggested_config: {
            scan_mode: 'standard',
            scan_frequency: confidence === 'high' ? 'weekly' : 'monthly',
            integration_id: ctx.integrationId,
          },
          confidence,
        };
      });

    return { assets, partial_error: partialError };
  },
};
