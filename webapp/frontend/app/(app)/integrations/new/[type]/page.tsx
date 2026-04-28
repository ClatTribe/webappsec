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
        We'll redirect you to GitHub to authorize Strix to access your repositories. The
        access token is stored encrypted in Supabase Vault and only decrypted at scan time.
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
function AwsForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [externalId, setExternalId] = useState('');
  const [region, setRegion] = useState('us-east-1');
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
        type: 'aws',
        name,
        secret_payload: { role_arn: roleArn, external_id: externalId, region },
        metadata: { role_arn: roleArn, region },
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
      <h1 className="text-2xl font-semibold">Connect AWS (IAM Role)</h1>
      <p className="text-sm text-neutral-400">
        Strix will assume this role at scan time and receive short-lived credentials. Configure
        the trust policy in your AWS account to allow Strix's account principal with the External ID below.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" value={name} onChange={setName} placeholder="prod-readonly" />
        <Field label="Role ARN" value={roleArn} onChange={setRoleArn} placeholder="arn:aws:iam::123456789012:role/strix-readonly" />
        <Field label="External ID" value={externalId} onChange={setExternalId} placeholder="optional" />
        <Field label="Region" value={region} onChange={setRegion} />
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
