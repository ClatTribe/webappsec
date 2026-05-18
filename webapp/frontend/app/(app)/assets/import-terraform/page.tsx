'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  ChevronRight,
  Upload,
  FileCode2,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Eye,
} from 'lucide-react';

// /targets/import-terraform — drop a terraform.tfstate, see which
// resources we'd ingest, click commit.

interface PreviewTarget {
  name: string;
  type: string;
  value: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

interface PreviewResponse {
  ok: boolean;
  dry_run?: boolean;
  summary?: {
    total_resources: number;
    matched: number;
    skipped_types?: Record<string, number>;
    // Only present on commit (non-dry-run) responses.
    created?: number;
    updated?: number;
    errored?: number;
  };
  targets?: PreviewTarget[];
  results?: Array<{
    input_index: number;
    external_id: string | null;
    target_id: string | null;
    action: 'created' | 'updated' | 'error';
    error: string | null;
  }>;
  hint?: string;
  error?: string;
}

export default function ImportTerraformPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stateText, setStateText] = useState('');
  const [defaultProjectSlug, setDefaultProjectSlug] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [submitting, setSubmitting] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setError('tfstate exceeds 10MB');
      return;
    }
    setStateText(await file.text());
    setResult(null);
    setPreview(null);
  }

  async function runPreview() {
    if (!stateText.trim()) return;
    setSubmitting('preview');
    setError(null);
    setResult(null);
    try {
      const qs = defaultProjectSlug.trim()
        ? `?project_slug=${encodeURIComponent(defaultProjectSlug.trim())}&dry_run=1`
        : '?dry_run=1';
      const res = await fetch(`/api/targets/import-terraform${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stateText,
      });
      const body = (await res.json().catch(() => ({}))) as PreviewResponse;
      if (!res.ok) {
        setError(body.error ?? 'Preview failed.');
        return;
      }
      setPreview(body);
    } finally {
      setSubmitting(null);
    }
  }

  async function commit() {
    if (!stateText.trim()) return;
    setSubmitting('commit');
    setError(null);
    try {
      const qs = defaultProjectSlug.trim()
        ? `?project_slug=${encodeURIComponent(defaultProjectSlug.trim())}`
        : '';
      const res = await fetch(`/api/targets/import-terraform${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stateText,
      });
      const body = (await res.json().catch(() => ({}))) as PreviewResponse;
      if (!res.ok) {
        setError(body.error ?? 'Import failed.');
        return;
      }
      setResult(body);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/assets" className="transition-colors hover:text-neutral-300">
          Targets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Import from Terraform</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">
            Bulk import from Terraform
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Drop a{' '}
          <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px]">
            terraform.tfstate
          </code>{' '}
          file. We extract every scannable resource — public ALBs, API
          Gateways, Cloud Run services, App Service apps, K8s
          LoadBalancer Services + Ingresses — and propose them as targets.
          Re-importing the same state is idempotent thanks to per-resource{' '}
          <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px]">
            external_id
          </code>
          .
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-neutral-600"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={2.5} />
            Choose tfstate file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".tfstate,.json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
          <span className="text-[11px] text-neutral-500">
            or paste the JSON below
          </span>
          <span className="ml-auto flex items-center gap-2">
            <label className="text-[11px] text-neutral-400">
              Default project slug:
            </label>
            <input
              type="text"
              value={defaultProjectSlug}
              onChange={(e) => setDefaultProjectSlug(e.target.value.toLowerCase())}
              placeholder="payments"
              className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            />
          </span>
        </div>

        <textarea
          value={stateText}
          onChange={(e) => setStateText(e.target.value)}
          rows={6}
          placeholder='{"version":4,"terraform_version":"1.x","resources":[...]}'
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runPreview}
            disabled={submitting !== null || !stateText.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
          >
            <Eye className="h-3.5 w-3.5" strokeWidth={2.5} />
            {submitting === 'preview' ? 'Parsing…' : 'Preview'}
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2.25} />
            <span>{error}</span>
          </div>
        )}
      </section>

      {/* Preview */}
      {preview?.targets && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Preview · {preview.targets.length} target
              {preview.targets.length === 1 ? '' : 's'} ready to import
            </h2>
            <span className="text-[11px] text-neutral-500">
              {preview.summary?.total_resources} resource
              {preview.summary?.total_resources === 1 ? '' : 's'} in state ·{' '}
              {preview.summary?.matched ?? 0} matched
            </span>
          </div>

          {preview.targets.length === 0 ? (
            <p className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-4 text-center text-sm text-neutral-500">
              {preview.hint ??
                'No scannable resources matched. Check the supported types listed above.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/30">
              <table className="w-full text-[11.5px]">
                <thead className="border-b border-neutral-800 bg-neutral-950/40 text-neutral-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">name</th>
                    <th className="px-3 py-2 text-left font-medium">type</th>
                    <th className="px-3 py-2 text-left font-medium">value</th>
                    <th className="px-3 py-2 text-left font-medium">resource</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.targets.slice(0, 25).map((t, i) => (
                    <tr key={i} className="border-b border-neutral-800/40">
                      <td className="px-3 py-1.5 text-neutral-100">{t.name}</td>
                      <td className="px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">
                        {t.type}
                      </td>
                      <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">
                        {t.value}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[10.5px] text-neutral-500">
                        {(t.metadata?.terraform_resource_type as string) ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.targets.length > 25 && (
                <p className="border-t border-neutral-800/60 px-3 py-2 text-[11px] text-neutral-500">
                  + {preview.targets.length - 25} more — all will be imported.
                </p>
              )}
            </div>
          )}

          {preview.summary?.skipped_types &&
            Object.keys(preview.summary.skipped_types).length > 0 && (
              <details className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-neutral-400">
                  {Object.keys(preview.summary.skipped_types).length} resource
                  type{Object.keys(preview.summary.skipped_types).length === 1 ? '' : 's'}{' '}
                  skipped (not externally scannable)
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[10.5px] text-neutral-500 sm:grid-cols-3">
                  {Object.entries(preview.summary.skipped_types).map(([k, n]) => (
                    <span key={k}>
                      {k} · {n}
                    </span>
                  ))}
                </div>
              </details>
            )}

          {preview.targets.length > 0 && !result && (
            <button
              type="button"
              onClick={commit}
              disabled={submitting !== null}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 disabled:opacity-50"
            >
              {submitting === 'commit' ? 'Importing…' : `Import ${preview.targets.length} target${preview.targets.length === 1 ? '' : 's'}`}
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
        </section>
      )}

      {/* Result */}
      {result?.summary && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Result
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ResultStat label="Created" value={result.summary.created ?? 0} tone="emerald" />
            <ResultStat label="Updated" value={result.summary.updated ?? 0} tone="cyan" />
            <ResultStat label="Errored" value={result.summary.errored ?? 0} tone="rose" />
            <ResultStat label="Resources in state" value={result.summary.total_resources} tone="neutral" />
          </div>
          <button
            type="button"
            onClick={() => router.push('/assets')}
            className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950"
          >
            View targets
          </button>
        </section>
      )}
    </div>
  );
}

function ResultStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'cyan' | 'rose' | 'neutral';
}) {
  const color = {
    emerald: 'text-emerald-300',
    cyan: 'text-cyan-300',
    rose: 'text-rose-300',
    neutral: 'text-neutral-200',
  }[tone];
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3">
      <div className={`text-2xl font-semibold ${value > 0 ? color : 'text-neutral-500'}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
    </div>
  );
}

