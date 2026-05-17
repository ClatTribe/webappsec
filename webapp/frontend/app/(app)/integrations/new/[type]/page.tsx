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
  if (type === 'k8s') return <KubeconfigForm />;
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push('/integrations');
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to save');
      return;
    }
    router.push('/integrations');
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
