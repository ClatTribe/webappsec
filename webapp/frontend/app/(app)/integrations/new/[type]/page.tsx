'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Props {
  params: { type: string };
}

export default function NewIntegrationPage({ params }: Props) {
  const { type } = params;

  if (type === 'github') return <GitHubFlow />;
  if (type === 'aws') return <AwsForm />;
  if (type === 'gcp') return <GcpForm />;
  if (type === 'k8s') return <KubeconfigForm />;
  if (type === 'domain') return <DomainForm />;
  if (type === 'okta') return <OktaForm />;
  // Skeletons for remaining types — same shape as AWS / k8s.
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect {type}</h1>
      <p className="text-sm text-neutral-400">
        Form for {type} not yet implemented in this scaffold. Add via the same pattern as AWS or K8s.
      </p>
      <Link href="/integrations" className="text-sm text-white underline">
        Back to integrations
      </Link>
    </div>
  );
}

// ===================== GITHUB =====================
function GitHubFlow() {
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect GitHub</h1>
      <p className="text-sm text-neutral-400">
        We'll redirect you to GitHub to authorize TensorShield to access your repositories. The
        access token is stored encrypted in the vault and only decrypted at scan time.
      </p>
      <a
        href="/api/integrations/oauth/github/start"
        className="inline-block rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-neutral-200"
      >
        Authorize GitHub
      </a>
    </div>
  );
}

// ===================== AWS =====================
//
// CSPM-aware AWS integration form. Powers two scan paths:
//   1. `cloud_account` targets (engine PRs #290/#291) — CSPM posture
//      scans against the live account.
//   2. Future drift correlation (engine PR #292) when this integration
//      is paired with a repository target containing Terraform.
//
// Two auth modes match the worker's existing credentials.py:
//   - IAM role + STS AssumeRole (preferred; short-lived creds at scan time)
//   - Direct access key (legacy; works without trust-policy setup)
type AwsAuthMode = 'role' | 'access_key';

function AwsForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<AwsAuthMode>('role');
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const secret_payload =
      mode === 'role'
        ? { role_arn: roleArn, external_id: externalId, region }
        : { access_key_id: accessKeyId, secret_access_key: secretAccessKey, region };
    // metadata is shown in the UI list (never sensitive); never echo secrets here.
    const metadata =
      mode === 'role'
        ? { auth_mode: 'role', role_arn: roleArn, region }
        : {
            auth_mode: 'access_key',
            region,
            // Last 4 chars only so the user can tell two keys apart.
            access_key_suffix: accessKeyId.slice(-4),
          };

    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'aws', name, secret_payload, metadata }),
    });
    setSubmitting(false);
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Failed to save');
      return;
    }
    // Phase A onboarding callout — drop the user straight into asset
    // discovery for the newly-connected integration. The discovered
    // page auto-triggers a fresh discovery when ?just_connected=1 is
    // set so the customer sees "we found 47 assets" within seconds.
    router.push(
      body.id ? `/integrations/${body.id}/discovered?just_connected=1` : '/integrations',
    );
  }

  const canSubmit =
    name.trim() &&
    (mode === 'role'
      ? roleArn.trim().match(/^arn:aws:iam::\d{12}:role\/.+$/)
      : accessKeyId.trim() && secretAccessKey.trim());

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect AWS</h1>
      <p className="text-sm text-neutral-400">
        Wire an AWS account for CSPM scans (CIS AWS Foundations Benchmark) and
        IaC↔drift correlation. We strongly recommend the IAM role flow — short-
        lived credentials minted at scan time via STS AssumeRole. Access keys are
        also supported for setups where the trust-policy round-trip is impractical.
      </p>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('role')}
          className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
            mode === 'role'
              ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100'
              : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
          }`}
        >
          <div className="font-medium">IAM role (recommended)</div>
          <div className="mt-0.5 text-[11px] text-neutral-500">
            STS AssumeRole; short-lived creds per scan
          </div>
        </button>
        <button
          type="button"
          onClick={() => setMode('access_key')}
          className={`flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
            mode === 'access_key'
              ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100'
              : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
          }`}
        >
          <div className="font-medium">Access key</div>
          <div className="mt-0.5 text-[11px] text-neutral-500">
            Direct long-lived AWS access key + secret
          </div>
        </button>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" value={name} onChange={setName} placeholder="prod-readonly" />

        {mode === 'role' ? (
          <>
            <Field
              label="Role ARN"
              value={roleArn}
              onChange={setRoleArn}
              placeholder="arn:aws:iam::123456789012:role/strix-readonly"
            />
            <Field
              label="External ID"
              value={externalId}
              onChange={setExternalId}
              placeholder="optional but recommended"
            />
            <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11.5px] text-amber-200/80">
              Configure the role&apos;s trust policy to allow our service principal as <code className="rounded bg-amber-500/15 px-1 font-mono">arn:aws:iam::TENSORSHIELD-AWS-ACCOUNT:role/scanner</code> and require the External ID above. Attach AWS&apos;s managed <code className="rounded bg-amber-500/15 px-1 font-mono">SecurityAudit</code> policy.
            </p>
          </>
        ) : (
          <>
            <Field
              label="Access key ID"
              value={accessKeyId}
              onChange={setAccessKeyId}
              placeholder="AKIA…"
            />
            <label className="flex flex-col text-sm">
              Secret access key
              <input
                type="password"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                placeholder="(stored encrypted in the vault)"
                className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
              />
            </label>
            <p className="rounded-md border border-rose-500/30 bg-rose-500/[0.05] px-3 py-2 text-[11.5px] text-rose-200/80">
              Long-lived keys are higher-risk than the role flow. The IAM user backing this key should have <code className="rounded bg-rose-500/15 px-1 font-mono">SecurityAudit</code> only — never an inline-admin policy.
            </p>
          </>
        )}

        <Field label="Region" value={region} onChange={setRegion} placeholder="us-east-1" />

        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="rounded-md bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save integration'}
        </button>
      </form>
    </div>
  );
}

// ===================== K8S =====================
function KubeconfigForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kubeconfig, setKubeconfig] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'k8s',
        name,
        secret_payload: { kubeconfig },
        metadata: {},
      }),
    });
    setSubmitting(false);
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push(
      body.id ? `/integrations/${body.id}/discovered?just_connected=1` : '/integrations',
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect Kubernetes</h1>
      <p className="text-sm text-neutral-400">
        Paste a kubeconfig. Recommended: a service account with read-only RBAC scoped to the
        namespaces you want tested.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" value={name} onChange={setName} placeholder="prod-cluster" />
        <label className="flex flex-col text-sm">
          Kubeconfig
          <textarea
            value={kubeconfig}
            onChange={(e) => setKubeconfig(e.target.value)}
            rows={14}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : 'Save integration'}
        </button>
      </form>
    </div>
  );
}

// ===================== GCP =====================
function GcpForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [saJson, setSaJson] = useState('');
  const [projectId, setProjectId] = useState('');
  const [workspaceDomain, setWorkspaceDomain] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The SA JSON is the source of truth for the project_id, but we
  // expose the override field so a service account with cross-project
  // access can target a specific one. We parse defensively — the
  // user might paste before the JSON is complete.
  function parseSaProject(input: string): string | null {
    try {
      const parsed = JSON.parse(input) as { project_id?: string };
      return parsed.project_id ?? null;
    } catch {
      return null;
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Validate the JSON before sending — gives the user a clear
    // inline error rather than a generic server failure.
    let parsed: { project_id?: string; client_email?: string };
    try {
      parsed = JSON.parse(saJson);
    } catch {
      setError('Service-account JSON is not valid JSON.');
      setSubmitting(false);
      return;
    }
    const resolvedProject = projectId.trim() || parsed.project_id || '';
    if (!resolvedProject) {
      setError(
        'No project_id detected in the SA JSON — set it in the override field above.',
      );
      setSubmitting(false);
      return;
    }

    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'gcp',
        name,
        // Vault payload — exactly what the worker's credentials.py
        // expects under integration.type='gcp'.
        secret_payload: { service_account_json: saJson },
        // Metadata is non-sensitive and shown in the UI. We include
        // the project_id explicitly so the collector + UI don't have
        // to re-parse the SA JSON, plus the SA client_email so users
        // can audit which identity their integration uses.
        metadata: {
          project_id: resolvedProject,
          client_email: parsed.client_email ?? null,
          workspace_domain: workspaceDomain.trim() || null,
        },
      }),
    });
    setSubmitting(false);
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push(
      body.id ? `/integrations/${body.id}/discovered?just_connected=1` : '/integrations',
    );
  }

  const autoProject = parseSaProject(saJson);

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect GCP</h1>
      <p className="text-sm text-neutral-400">
        Paste a service-account JSON key with read-only scope on the target
        project. The SA should hold{' '}
        <code className="rounded bg-neutral-800 px-1 font-mono text-[11px]">
          roles/iam.securityReviewer
        </code>{' '}
        (or at minimum{' '}
        <code className="rounded bg-neutral-800 px-1 font-mono text-[11px]">
          roles/viewer
        </code>
        ) so the evidence collector can read IAM policy + SA keys.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" value={name} onChange={setName} placeholder="prod-readonly" />
        <label className="flex flex-col text-sm">
          Service-account JSON key
          <textarea
            value={saJson}
            onChange={(e) => setSaJson(e.target.value)}
            placeholder='{ "type": "service_account", "project_id": "...", "private_key": "...", ... }'
            rows={10}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
          />
          <span className="mt-1 text-[10.5px] text-neutral-500">
            Stored encrypted in the vault. We never log or display the contents
            after save.
          </span>
        </label>
        <Field
          label={`Project ID (override${autoProject ? ` — auto-detected: ${autoProject}` : ''})`}
          value={projectId}
          onChange={setProjectId}
          placeholder={autoProject ?? 'my-project-id'}
        />
        <Field
          label="Workspace domain (optional)"
          value={workspaceDomain}
          onChange={setWorkspaceDomain}
          placeholder="acme.com"
        />
        <p className="rounded-md border border-cyan-500/30 bg-cyan-500/[0.05] px-3 py-2 text-[11.5px] text-cyan-200/80">
          Workspace domain is used by the IAM evidence collector to distinguish
          your-domain identities from external ones (e.g. a gmail.com user
          accidentally granted Owner). Leave blank and the collector will only
          flag <code className="font-mono">@gmail.com</code> bindings.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !name.trim() || !saJson.trim()}
          className="rounded-md bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save integration'}
        </button>
      </form>
    </div>
  );
}

// ===================== DOMAIN =====================
// Apex-domain "integration" — no credentials. Powers subdomain
// enumeration via the domain_subdomains discoverer (crt.sh).
function DomainForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [apex, setApex] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const clean = apex.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean)) {
      setError('Enter a valid apex domain (e.g. acme.com)');
      setSubmitting(false);
      return;
    }
    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'domain',
        name: name.trim() || clean,
        // Vault payload — the discoverer reads { apex } at run time.
        secret_payload: { apex: clean },
        // Metadata is non-sensitive; we duplicate apex here so the
        // /integrations list can show it without decrypting.
        metadata: { apex: clean },
      }),
    });
    setSubmitting(false);
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push(
      body.id ? `/integrations/${body.id}/discovered?just_connected=1` : '/integrations',
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect apex domain</h1>
      <p className="text-sm text-neutral-400">
        Registers an apex domain (e.g.{' '}
        <code className="rounded bg-neutral-800 px-1 font-mono text-[11px]">acme.com</code>)
        for subdomain enumeration. We poll public certificate-transparency logs
        — no DNS probing of your own infrastructure, no credentials needed. Each
        live subdomain we find gets proposed as a web_application target you can
        bulk-approve under{' '}
        <code className="rounded bg-neutral-800 px-1 font-mono text-[11px]">
          /integrations/&lt;id&gt;/discovered
        </code>
        .
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Name (optional)"
          value={name}
          onChange={setName}
          placeholder="acme corp public surface"
        />
        <Field
          label="Apex domain"
          value={apex}
          onChange={setApex}
          placeholder="acme.com"
        />
        <p className="rounded-md border border-cyan-500/30 bg-cyan-500/[0.05] px-3 py-2 text-[11.5px] text-cyan-200/80">
          Subdomain enumeration runs daily by default. Results from
          certificate-transparency are typically comprehensive for hosts with
          publicly-issued TLS certs; internal-CA-only hosts won&apos;t surface
          here.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !apex.trim()}
          className="rounded-md bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save integration'}
        </button>
      </form>
    </div>
  );
}

// ===================== OKTA =====================
function OktaForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [orgUrl, setOrgUrl] = useState('');
  const [sswsToken, setSswsToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const cleanOrg = orgUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.okta(?:preview|-emea|preview-emea)?\.com$/i.test(cleanOrg)) {
      setError('Org URL should look like https://acme.okta.com (no trailing path).');
      setSubmitting(false);
      return;
    }
    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'okta',
        name: name.trim() || cleanOrg,
        // Vault payload — Okta collector reads { ssws_token, org_url }.
        secret_payload: { ssws_token: sswsToken.trim(), org_url: cleanOrg },
        // org_url duplicated in metadata for non-secret display.
        metadata: { org_url: cleanOrg },
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push('/integrations');
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect Okta</h1>
      <p className="text-sm text-neutral-400">
        Reads MFA enrollment, privileged-role assignments, API token age,
        and inactive accounts from your Okta tenant. The SSWS token needs
        the <code className="rounded bg-neutral-800 px-1 font-mono text-[11px]">Read-Only Admin</code>{' '}
        role at minimum.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Name (optional)"
          value={name}
          onChange={setName}
          placeholder="acme okta tenant"
        />
        <Field
          label="Org URL"
          value={orgUrl}
          onChange={setOrgUrl}
          placeholder="https://acme.okta.com"
        />
        <label className="flex flex-col text-sm">
          SSWS API token
          <input
            type="password"
            value={sswsToken}
            onChange={(e) => setSswsToken(e.target.value)}
            placeholder="00abc... (stored encrypted in the vault)"
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          />
          <span className="mt-1 text-[10.5px] text-neutral-500">
            Create at Okta Admin → Security → API → Tokens. Use a token tied
            to a service account so revoking it doesn&apos;t affect a real user.
          </span>
        </label>
        <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11.5px] text-amber-200/80">
          Use the tenant URL (e.g.{' '}
          <code className="font-mono">https://acme.okta.com</code>), NOT the
          admin URL (<code className="font-mono">https://acme-admin.okta.com</code>).
          The admin URL responds with HTML redirects that break the JSON API.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !sswsToken.trim() || !orgUrl.trim()}
          className="rounded-md bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save integration'}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col text-sm">
      {label}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
      />
    </label>
  );
}
