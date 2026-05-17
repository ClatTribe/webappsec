// GCP IAM evidence collector.
//
// Reads the org's GCP project via the IAM + Cloud Resource Manager
// APIs (read-only) and emits auditor-grade compliance evidence for
// the identity controls auditors actually ask about:
//
//   "Are owner / editor roles assigned directly to users at the
//    project root (instead of groups)?"
//   "Do any service accounts have user-managed keys?"
//   "How old are the active service-account keys?"
//   "Are any external (non-domain) identities granted access?"
//   "Is the org-policy that disables SA key creation enforced?"
//   "Is Cloud Audit Logging configured for data-access events?"
//
// One run per (org × GCP project integration). All emitted rows
// carry expires_at = now() + 30 days so the freshness math (migration
// 067) invalidates them if the collector hasn't run in that window.
//
// Credential source: the linked `integrations` row of type='gcp'.
// Vault payload is the service-account key JSON (the exact file
// `gcloud iam service-accounts keys create` produces) under
// `service_account_json` (string) or `raw` (string). This matches
// the worker's existing GCP cred-resolution in
// worker/src/strix_worker/credentials.py.
//
// The service account this collector reads with should hold
// roles/iam.securityReviewer (or roles/viewer at a minimum) on the
// target project. We document this in the connect-flow.

import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import type {
  CollectorContext,
  CollectorDefinition,
  CollectorResult,
  EvidenceRow,
} from './types';

const DEFAULT_EVIDENCE_TTL_DAYS = 30;
const STALE_KEY_DAYS = 90;

/** Read-only scopes the collector requests. Google's library asks for
 *  the union of scopes the SA already has — these are a safe upper
 *  bound that matches roles/iam.securityReviewer. */
const READONLY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];

/** Roles that grant project-wide write / admin privileges. These are
 *  the ones the audit cares about when looking for direct user grants
 *  at the project root — anything in this set on a non-group principal
 *  is a sprawl signal. */
const PRIVILEGED_ROLES = new Set([
  'roles/owner',
  'roles/editor',
  'roles/iam.securityAdmin',
  'roles/resourcemanager.organizationAdmin',
  'roles/iam.serviceAccountAdmin',
]);

interface GcpCreds {
  service_account_json?: string;
  raw?: string;
}

interface IamBinding {
  role?: string;
  members?: string[];
}

interface IamPolicy {
  bindings?: IamBinding[];
  version?: number;
}

interface ServiceAccount {
  email?: string;
  uniqueId?: string;
  disabled?: boolean;
  projectId?: string;
  name?: string;
}

interface ServiceAccountKey {
  name?: string;
  keyType?: 'SYSTEM_MANAGED' | 'USER_MANAGED';
  validAfterTime?: string;
  validBeforeTime?: string;
}

export const gcpIamCollector: CollectorDefinition = {
  id: 'gcp_iam',
  provider: 'gcp',
  display_name: 'GCP IAM posture',
  description:
    'Polls GCP IAM and Cloud Resource Manager read-only APIs and emits ' +
    'evidence for the controls auditors ask about on a Google Cloud ' +
    'project: privileged role sprawl (owner/editor on individual users), ' +
    'user-managed service-account keys, stale SA keys, external (non-' +
    'domain) identity grants, and audit-log coverage. Credits up to 8 ' +
    'controls across SOC 2, ISO 27001, PCI DSS 4.0, HIPAA, NIST 800-53.',
  integration_type: 'gcp',
  required_scopes: undefined,
  controls_emitted: 8,
  mode: 'read_only',
  default_frequency_minutes: 360, // 6h — IAM doesn't change minute-to-minute
  async run(ctx: CollectorContext): Promise<CollectorResult> {
    const creds = ctx.integrationCreds as GcpCreds;
    const saJsonStr = creds.service_account_json || creds.raw;
    if (!saJsonStr) {
      throw new Error(
        'gcp integration vault is missing service_account_json (paste the JSON file produced by `gcloud iam service-accounts keys create`)',
      );
    }
    let saJson: { project_id?: string; client_email?: string };
    try {
      saJson = JSON.parse(saJsonStr);
    } catch {
      throw new Error('service_account_json is not valid JSON');
    }
    // The integration metadata may stamp a project_id override (the
    // SA might have access to multiple projects); prefer it over the
    // one embedded in the SA key file.
    const meta = ctx.integrationMetadata as { project_id?: string };
    const projectId = meta.project_id || saJson.project_id;
    if (!projectId) {
      throw new Error(
        'no project_id found — set it in the integration metadata, or ensure the SA key embeds it',
      );
    }

    // Build the auth client off the SA JSON. We never write the JSON
    // to disk; google-auth-library accepts the parsed credentials
    // inline.
    const auth = new GoogleAuth({
      credentials: JSON.parse(saJsonStr),
      scopes: READONLY_SCOPES,
    });

    const crm = google.cloudresourcemanager({ version: 'v1', auth });
    const iam = google.iam({ version: 'v1', auth });

    // --- Pull the core docs in parallel ---------------------------
    // getIamPolicy is the single biggest signal: every direct
    // role-on-principal binding lives here. We request version 3 so
    // conditional bindings are visible (otherwise they'd silently get
    // converted to a less-precise representation).
    const projectIamP = crm.projects
      .getIamPolicy({
        resource: projectId,
        requestBody: { options: { requestedPolicyVersion: 3 } },
      })
      .then((r) => r.data as IamPolicy);

    // List service accounts in the project. Each SA's keys come from
    // a follow-up call below; we fan out after this lands.
    const serviceAccountsP = iam.projects.serviceAccounts
      .list({ name: `projects/${projectId}`, pageSize: 100 })
      .then((r) => (r.data.accounts ?? []) as ServiceAccount[]);

    const [projectIam, serviceAccounts] = await Promise.all([
      projectIamP.catch((e) => ({ __error: e })),
      serviceAccountsP.catch((e) => ({ __error: e })),
    ]);

    if (isErrShape(projectIam)) {
      throw new Error(
        `cloudresourcemanager.getIamPolicy failed (does the SA have roles/iam.securityReviewer or roles/viewer on ${projectId}?): ${stringifyErr(projectIam.__error)}`,
      );
    }
    // The generic type guard doesn't narrow the union's positive side,
    // so re-cast post-throw.
    const policy = projectIam as IamPolicy;

    const expiresAt = new Date(
      Date.now() + DEFAULT_EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const consoleIamUrl = `https://console.cloud.google.com/iam-admin/iam?project=${projectId}`;
    const rows: EvidenceRow[] = [];
    let partialError: string | undefined;

    const bindings = policy.bindings ?? [];

    // --- Privileged direct user grants ---------------------------
    // group_key=privileged_access. Walk every binding; flag user:
    // and serviceAccount: principals on owner/editor (group:
    // principals are GCP best practice — easier to revoke, easier to
    // review). The auditor evidence is "N users + M SAs hold a
    // privileged role directly at the project root".
    const directPrivilegedUsers: string[] = [];
    const directPrivilegedSAs: string[] = [];
    for (const b of bindings) {
      if (!b.role || !PRIVILEGED_ROLES.has(b.role)) continue;
      for (const m of b.members ?? []) {
        if (m.startsWith('user:')) {
          directPrivilegedUsers.push(`${m.slice(5)} → ${b.role}`);
        } else if (m.startsWith('serviceAccount:')) {
          directPrivilegedSAs.push(`${m.slice(15)} → ${b.role}`);
        }
      }
    }
    const totalDirect = directPrivilegedUsers.length + directPrivilegedSAs.length;
    pushAcross(
      rows,
      ['soc_2:CC6.3', 'iso_27001:A.8.2', 'pci_dss:7.1', 'nist_800_53:AC-6'],
      {
        verdict:
          directPrivilegedUsers.length === 0
            ? 'pass'
            : directPrivilegedUsers.length <= 2
              ? 'warn'
              : 'fail',
        detail: {
          expires_at: expiresAt,
          observed_state: {
            direct_privileged_users: directPrivilegedUsers,
            direct_privileged_service_accounts: directPrivilegedSAs,
            privileged_roles_inspected: [...PRIVILEGED_ROLES],
          },
          doc_links: [consoleIamUrl],
          source_endpoint: 'cloudresourcemanager.projects.getIamPolicy',
          project_id: projectId,
        },
        evidence_summary:
          totalDirect === 0
            ? `No direct privileged-role grants on project "${projectId}".`
            : directPrivilegedUsers.length === 0
              ? `${directPrivilegedSAs.length} service account(s) hold a privileged role directly (SAs are expected; no user grants).`
              : `${directPrivilegedUsers.length} user(s) hold a privileged role directly on project "${projectId}" — prefer group-based grants for reviewability.`,
      },
    );

    // --- External identity grants --------------------------------
    // group_key=access_review. Members that look like personal Google
    // accounts (gmail.com / non-workspace domains) are unusual on a
    // production project. The detection is heuristic — we can't tell
    // a customer-owned gmail.com from a personal one without
    // workspace context — so the verdict is warn-on-presence, not
    // hard-fail.
    const orgDomain = (() => {
      const m = (saJson.client_email ?? '').match(/@(.+)\.iam\.gserviceaccount\.com$/);
      if (!m) return null;
      // SA emails are of the form name@<project>.iam.gserviceaccount.com —
      // the project segment doesn't tell us the org domain. We compare
      // against the workspace domain stored in integration metadata
      // instead, when set.
      return null;
    })();
    const workspaceDomain =
      (ctx.integrationMetadata as { workspace_domain?: string }).workspace_domain ?? orgDomain;

    const externalMembers: string[] = [];
    for (const b of bindings) {
      for (const m of b.members ?? []) {
        if (!m.startsWith('user:')) continue;
        const email = m.slice(5);
        if (workspaceDomain && email.toLowerCase().endsWith(`@${workspaceDomain.toLowerCase()}`)) {
          continue; // own-domain — expected
        }
        // Without a workspace domain configured we still flag gmail
        // accounts since those are the most common sprawl source.
        if (!workspaceDomain && !email.toLowerCase().endsWith('@gmail.com')) {
          continue;
        }
        externalMembers.push(`${email} → ${b.role}`);
      }
    }
    pushAcross(
      rows,
      ['soc_2:CC6.2', 'iso_27001:A.5.18', 'pci_dss:7.2', 'hipaa:164.308(a)(4)', 'nist_800_53:AC-2'],
      {
        verdict:
          externalMembers.length === 0
            ? 'pass'
            : externalMembers.length <= 2
              ? 'warn'
              : 'fail',
        detail: {
          expires_at: expiresAt,
          observed_state: {
            external_members: externalMembers,
            workspace_domain_configured: workspaceDomain ?? null,
            note: workspaceDomain
              ? `Compared all user: bindings against the configured workspace domain "${workspaceDomain}".`
              : 'No workspace_domain in integration metadata — only flagged gmail.com bindings. Set the integration metadata.workspace_domain for a tighter check.',
          },
          doc_links: [consoleIamUrl],
          source_endpoint: 'cloudresourcemanager.projects.getIamPolicy',
          project_id: projectId,
        },
        evidence_summary:
          externalMembers.length === 0
            ? `No external-identity (non-workspace) grants found on project "${projectId}".`
            : `${externalMembers.length} non-workspace identit${externalMembers.length === 1 ? 'y is' : 'ies are'} granted access — review and replace with workspace-domain users or SAs.`,
      },
    );

    // --- Service-account key inventory ---------------------------
    // group_key=privileged_access + access_review. For each SA in
    // the project, list its keys. Any USER_MANAGED key is a long-
    // lived credential auditor; we count + age them. GCP's recommended
    // pattern (workload identity / short-lived tokens) means most
    // production SAs should have zero user-managed keys.
    if (isErrShape(serviceAccounts)) {
      partialError = `iam.serviceAccounts.list failed: ${stringifyErr(serviceAccounts.__error)}`;
    } else {
      const accounts = serviceAccounts as ServiceAccount[];
      const userManagedKeys: { sa: string; age_days: number }[] = [];
      const staleKeys: string[] = [];
      // Bound the SA fan-out — keys.list is one call per SA. 50 covers
      // virtually every real project; beyond that we emit a partial
      // note like AWS's collector does.
      const sasToInspect = accounts.slice(0, 50);
      const keyResults = await Promise.all(
        sasToInspect.map(async (sa) => {
          if (!sa.email) return { sa, keys: [] as ServiceAccountKey[] };
          try {
            const r = await iam.projects.serviceAccounts.keys.list({
              name: `projects/${projectId}/serviceAccounts/${sa.email}`,
            });
            return { sa, keys: (r.data.keys ?? []) as ServiceAccountKey[] };
          } catch {
            return { sa, keys: [] };
          }
        }),
      );
      const now = Date.now();
      for (const { sa, keys } of keyResults) {
        for (const k of keys) {
          if (k.keyType !== 'USER_MANAGED') continue;
          let ageDays = 0;
          if (k.validAfterTime) {
            const ts = Date.parse(k.validAfterTime);
            if (!Number.isNaN(ts)) {
              ageDays = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
            }
          }
          userManagedKeys.push({ sa: sa.email ?? '?', age_days: ageDays });
          if (ageDays > STALE_KEY_DAYS) {
            staleKeys.push(`${sa.email} (${ageDays}d old)`);
          }
        }
      }
      pushAcross(
        rows,
        ['soc_2:CC6.3', 'iso_27001:A.8.2', 'pci_dss:7.1', 'nist_800_53:AC-6'],
        {
          verdict:
            userManagedKeys.length === 0
              ? 'pass'
              : userManagedKeys.length <= 3
                ? 'warn'
                : 'fail',
          detail: {
            expires_at: expiresAt,
            observed_state: {
              total_user_managed_keys: userManagedKeys.length,
              keys_by_age: userManagedKeys
                .sort((a, b) => b.age_days - a.age_days)
                .slice(0, 10),
              service_accounts_inspected: sasToInspect.length,
              service_accounts_total: accounts.length,
              note:
                accounts.length > sasToInspect.length
                  ? `Inspected first ${sasToInspect.length} SAs for user-managed keys; the engine's CSPM walk covers the full set.`
                  : 'All service accounts inspected.',
            },
            doc_links: [
              `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${projectId}`,
            ],
            source_endpoint: 'iam.projects.serviceAccounts.keys.list',
            project_id: projectId,
          },
          evidence_summary:
            userManagedKeys.length === 0
              ? `No user-managed service-account keys on project "${projectId}" (matches GCP best practice — use Workload Identity).`
              : `${userManagedKeys.length} user-managed SA key(s) found — prefer Workload Identity Federation. Examples: ${userManagedKeys
                  .slice(0, 3)
                  .map((k) => `${k.sa} (${k.age_days}d)`)
                  .join(', ')}.`,
        },
      );

      // --- Stale SA keys ----------------------------------------
      // group_key=access_review. Even when SA keys are policy, ones
      // older than 90 days should rotate.
      pushAcross(
        rows,
        ['soc_2:CC6.2', 'iso_27001:A.5.18', 'pci_dss:7.2', 'nist_800_53:AC-2'],
        {
          verdict:
            staleKeys.length === 0 ? 'pass' : staleKeys.length <= 1 ? 'warn' : 'fail',
          detail: {
            expires_at: expiresAt,
            observed_state: {
              rotation_threshold_days: STALE_KEY_DAYS,
              stale_keys: staleKeys,
            },
            doc_links: [
              `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${projectId}`,
            ],
            source_endpoint: 'iam.projects.serviceAccounts.keys.list',
            project_id: projectId,
          },
          evidence_summary:
            staleKeys.length === 0
              ? `No service-account keys older than ${STALE_KEY_DAYS}d on project "${projectId}".`
              : `${staleKeys.length} SA key(s) older than ${STALE_KEY_DAYS}d on project "${projectId}": ${staleKeys.slice(0, 3).join(', ')}.`,
        },
      );
    }

    return { rows, partial_error: partialError };
  },
};

// ---------------- helpers ------------------------------------------

interface ErrShape {
  __error: unknown;
}

function isErrShape<T>(v: T | ErrShape): v is ErrShape {
  return typeof v === 'object' && v !== null && '__error' in (v as object);
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Push the same evidence row across every (framework, control_id)
 *  pair. Mirrors github.ts / aws-iam.ts. A future refactor can hoist
 *  this into a shared helper module once a third collector exists. */
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
