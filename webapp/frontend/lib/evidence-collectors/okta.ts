// Okta evidence collector.
//
// Polls the org's Okta tenant via the SSWS-token Admin REST API and
// emits auditor-grade evidence for the identity controls auditors
// ask about on an IdP — the four-way trifecta of:
//
//   - MFA factor enrollment + enforcement
//   - Privileged role sprawl (super_admin / org_admin counts)
//   - Stale API tokens (older than 90 days)
//   - Inactive accounts (lastLogin > 90 days)
//
// Credential model:
//   vault payload: { ssws_token: string, org_url: string }
//   The SSWS token needs at minimum the "Read-Only Admin" role.
//   org_url should be the full tenant URL — https://acme.okta.com
//   (NOT the admin URL https://acme-admin.okta.com).
//
// Credits ~6 controls across SOC 2 / ISO 27001 / PCI DSS 4.0 / HIPAA
// / NIST 800-53 via the cross-framework mapping groups in migration
// 071 (mfa_enforcement, access_review, privileged_access).

import type {
  CollectorContext,
  CollectorDefinition,
  CollectorResult,
  EvidenceRow,
} from './types';

const DEFAULT_EVIDENCE_TTL_DAYS = 30;
const STALE_DAYS = 90;
// Okta's two highest-privilege roles. The full role list also includes
// API_ACCESS_MANAGEMENT_ADMIN, USER_ADMIN, etc — those are scoped
// admin roles. We flag broad-scope admins only; scoped-admin
// inventory is a follow-up if customers ask.
const PRIVILEGED_ROLES = new Set(['SUPER_ADMIN', 'ORG_ADMIN']);

interface OktaCreds {
  ssws_token?: string;
  org_url?: string;
}

interface OktaUser {
  id: string;
  status: string; // ACTIVE | PROVISIONED | LOCKED_OUT | SUSPENDED | DEPROVISIONED | RECOVERY | STAGED | PASSWORD_EXPIRED
  created: string;
  activated?: string | null;
  lastLogin?: string | null;
  lastUpdated?: string;
  profile?: {
    login?: string;
    email?: string;
  };
}

interface OktaFactor {
  id?: string;
  factorType: string;
  status: string; // ACTIVE | PENDING_ACTIVATION
}

interface OktaPolicyRule {
  id?: string;
  name?: string;
  actions?: {
    enroll?: { self?: string };
  };
}

interface OktaApiToken {
  id?: string;
  name?: string;
  userId?: string;
  expiresAt?: string;
  lastUpdated?: string;
}

interface OktaRoleAssignment {
  id?: string;
  type?: string;
  label?: string;
}

export const oktaCollector: CollectorDefinition = {
  id: 'okta_posture',
  provider: 'okta',
  display_name: 'Okta identity posture',
  description:
    'Polls Okta admin APIs and emits evidence for the controls ' +
    'auditors ask about on an IdP: MFA enrollment coverage, ' +
    'privileged role sprawl (super/org admins), stale API tokens, ' +
    'and inactive accounts. Credits up to 6 controls across SOC 2, ' +
    'ISO 27001, PCI DSS 4.0, HIPAA, NIST 800-53.',
  integration_type: 'okta',
  required_scopes: undefined,
  controls_emitted: 6,
  mode: 'read_only',
  default_frequency_minutes: 360, // 6h
  async run(ctx: CollectorContext): Promise<CollectorResult> {
    const creds = ctx.integrationCreds as OktaCreds;
    const sswsToken = creds.ssws_token;
    const orgUrl = (creds.org_url ?? '').trim().replace(/\/+$/, '');
    if (!sswsToken || !orgUrl) {
      throw new Error(
        'okta integration vault is missing ssws_token or org_url',
      );
    }
    if (!/^https:\/\/[a-z0-9-]+\.okta(?:preview|-emea|preview-emea)?\.com$/i.test(orgUrl)) {
      throw new Error(
        `org_url "${orgUrl}" doesn't match the expected pattern (e.g. https://acme.okta.com)`,
      );
    }

    const headers = {
      authorization: `SSWS ${sswsToken}`,
      accept: 'application/json',
      'user-agent': 'tensorshield-evidence-collector/1.0',
    };

    const expiresAt = new Date(
      Date.now() + DEFAULT_EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows: EvidenceRow[] = [];
    const errors: string[] = [];

    // --- 1. List active users (paginated; cap at 1000) ---------
    const users: OktaUser[] = [];
    try {
      let nextUrl: string | null = `${orgUrl}/api/v1/users?limit=200&filter=status%20eq%20%22ACTIVE%22`;
      let pages = 0;
      while (nextUrl && pages < 5) {
        const res = await fetch(nextUrl, { headers });
        if (!res.ok) {
          throw new Error(`Okta /users returned ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
        }
        const batch = (await res.json()) as OktaUser[];
        users.push(...batch);
        nextUrl = parseLinkHeader(res.headers.get('link') ?? '');
        pages += 1;
      }
    } catch (e) {
      throw new Error(
        `Okta /users failed (does the SSWS token have read-only admin?): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // --- 2. MFA enrollment per user (best-effort, capped) ------
    // Per-user factor list is one call each. We sample the first 200
    // active users to keep the request budget bounded; the detail
    // documents the cap so auditors see it.
    const usersToSample = users.slice(0, 200);
    let mfaEnrolled = 0;
    let mfaNotEnrolled: string[] = [];
    await Promise.all(
      usersToSample.map(async (u) => {
        try {
          const res = await fetch(`${orgUrl}/api/v1/users/${u.id}/factors`, {
            headers,
          });
          if (!res.ok) return;
          const factors = (await res.json()) as OktaFactor[];
          const hasActiveFactor = factors.some(
            (f) => f.status === 'ACTIVE' && f.factorType !== 'password',
          );
          if (hasActiveFactor) mfaEnrolled += 1;
          else mfaNotEnrolled.push(u.profile?.login ?? u.id);
        } catch {
          // Per-user failures shouldn't crater the collector
        }
      }),
    );
    const mfaCoverage =
      usersToSample.length > 0 ? mfaEnrolled / usersToSample.length : 1;
    pushAcross(
      rows,
      ['soc_2:CC6.1', 'iso_27001:A.8.5', 'pci_dss:8.4', 'hipaa:164.312(a)(2)(i)', 'nist_800_53:IA-2'],
      {
        verdict:
          mfaCoverage === 1
            ? 'pass'
            : mfaCoverage >= 0.95
              ? 'warn'
              : 'fail',
        detail: {
          expires_at: expiresAt,
          observed_state: {
            users_sampled: usersToSample.length,
            users_total_active: users.length,
            mfa_enrolled: mfaEnrolled,
            mfa_not_enrolled: mfaNotEnrolled.slice(0, 10),
            coverage_pct: Math.round(mfaCoverage * 100),
          },
          doc_links: [`${orgUrl}/admin/access/multifactor`],
          source_endpoint: 'okta:/api/v1/users/{id}/factors',
        },
        evidence_summary:
          usersToSample.length === 0
            ? 'No active users in the Okta tenant.'
            : mfaCoverage === 1
              ? `All ${usersToSample.length} sampled active users have at least one active MFA factor.`
              : `${mfaNotEnrolled.length} of ${usersToSample.length} sampled active users have NO MFA factor: ${mfaNotEnrolled.slice(0, 3).join(', ')}.`,
      },
    );

    // --- 3. Privileged role sprawl -------------------------------
    // Each user's `/roles` list is also one call per user; we limit
    // to users we already loaded to bound the budget. Most orgs
    // have <20 super/org admins so this lands quickly.
    const directAdmins: string[] = [];
    await Promise.all(
      usersToSample.map(async (u) => {
        try {
          const res = await fetch(`${orgUrl}/api/v1/users/${u.id}/roles`, {
            headers,
          });
          if (!res.ok) return;
          const roles = (await res.json()) as OktaRoleAssignment[];
          if (roles.some((r) => r.type && PRIVILEGED_ROLES.has(r.type))) {
            directAdmins.push(u.profile?.login ?? u.id);
          }
        } catch {
          /* per-user failure tolerated */
        }
      }),
    );
    pushAcross(
      rows,
      ['soc_2:CC6.3', 'iso_27001:A.8.2', 'pci_dss:7.1', 'nist_800_53:AC-6'],
      {
        verdict:
          directAdmins.length === 0
            ? 'info' // having zero admins is unusual; flag for review
            : directAdmins.length <= 2
              ? 'pass'
              : directAdmins.length <= 5
                ? 'warn'
                : 'fail',
        detail: {
          expires_at: expiresAt,
          observed_state: {
            super_or_org_admins: directAdmins,
            count: directAdmins.length,
            privileged_roles_inspected: [...PRIVILEGED_ROLES],
            users_sampled: usersToSample.length,
          },
          doc_links: [`${orgUrl}/admin/access/admins`],
          source_endpoint: 'okta:/api/v1/users/{id}/roles',
        },
        evidence_summary:
          directAdmins.length === 0
            ? 'No SUPER_ADMIN or ORG_ADMIN users found in the sampled set (review: the org likely has at least one).'
            : `${directAdmins.length} user(s) hold SUPER_ADMIN or ORG_ADMIN — keep this number small; examples: ${directAdmins.slice(0, 3).join(', ')}.`,
      },
    );

    // --- 4. Stale API tokens -------------------------------------
    try {
      const res = await fetch(`${orgUrl}/api/v1/api-tokens`, { headers });
      if (res.ok) {
        const tokens = (await res.json()) as OktaApiToken[];
        const now = Date.now();
        const stale = tokens.filter((t) => {
          const updated = t.lastUpdated ? Date.parse(t.lastUpdated) : NaN;
          if (Number.isNaN(updated)) return false;
          return now - updated > STALE_DAYS * 24 * 60 * 60 * 1000;
        });
        pushAcross(
          rows,
          ['soc_2:CC6.2', 'iso_27001:A.5.18', 'pci_dss:7.2', 'nist_800_53:AC-2'],
          {
            verdict:
              stale.length === 0
                ? 'pass'
                : stale.length <= 2
                  ? 'warn'
                  : 'fail',
            detail: {
              expires_at: expiresAt,
              observed_state: {
                rotation_threshold_days: STALE_DAYS,
                total_tokens: tokens.length,
                stale_tokens: stale.map((t) => ({
                  name: t.name,
                  last_updated: t.lastUpdated,
                })),
              },
              doc_links: [`${orgUrl}/admin/access/api/tokens`],
              source_endpoint: 'okta:/api/v1/api-tokens',
            },
            evidence_summary:
              tokens.length === 0
                ? 'No active Okta API tokens.'
                : stale.length === 0
                  ? `All ${tokens.length} Okta API tokens have been rotated within the last ${STALE_DAYS} days.`
                  : `${stale.length} of ${tokens.length} Okta API tokens are older than ${STALE_DAYS} days: ${stale.slice(0, 3).map((t) => t.name).join(', ')}.`,
          },
        );
      } else {
        errors.push(`api-tokens: ${res.status}`);
      }
    } catch (e) {
      errors.push(
        `api-tokens: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // --- 5. Inactive accounts -------------------------------------
    const now = Date.now();
    const inactive = users.filter((u) => {
      if (u.status !== 'ACTIVE') return false;
      if (!u.lastLogin) return true; // never logged in but somehow ACTIVE
      const ts = Date.parse(u.lastLogin);
      if (Number.isNaN(ts)) return false;
      return now - ts > STALE_DAYS * 24 * 60 * 60 * 1000;
    });
    pushAcross(
      rows,
      ['soc_2:CC6.2', 'iso_27001:A.5.18', 'pci_dss:7.2', 'hipaa:164.308(a)(4)', 'nist_800_53:AC-2'],
      {
        verdict:
          inactive.length === 0
            ? 'pass'
            : inactive.length <= 2
              ? 'warn'
              : 'fail',
        detail: {
          expires_at: expiresAt,
          observed_state: {
            stale_threshold_days: STALE_DAYS,
            total_active: users.length,
            inactive_count: inactive.length,
            offenders: inactive.slice(0, 10).map((u) => u.profile?.login ?? u.id),
          },
          doc_links: [`${orgUrl}/admin/users`],
          source_endpoint: 'okta:/api/v1/users',
        },
        evidence_summary:
          inactive.length === 0
            ? `No active Okta users have been idle for >${STALE_DAYS} days.`
            : `${inactive.length} active Okta users haven't logged in in >${STALE_DAYS} days: ${inactive.slice(0, 3).map((u) => u.profile?.login ?? u.id).join(', ')}.`,
      },
    );

    return {
      rows,
      partial_error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};

/** Okta uses RFC 5988 Link headers for pagination. Extract the `next`
 *  URL when present; return null when we're on the last page. */
function parseLinkHeader(link: string): string | null {
  if (!link) return null;
  const segments = link.split(',');
  for (const seg of segments) {
    const m = seg.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

function pushAcross(
  out: EvidenceRow[],
  controls: string[],
  body: Omit<EvidenceRow, 'framework' | 'control_id'>,
): void {
  for (const c of controls) {
    const [framework, controlId] = c.split(':');
    if (!framework || !controlId) continue;
    out.push({ framework, control_id: controlId, ...body });
  }
}
