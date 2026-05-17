'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Papa from 'papaparse';
import {
  ChevronRight,
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Eye,
  ArrowRight,
} from 'lucide-react';

// /targets/import-csv — bulk CSV import flow.
//
// Three states:
//   - blank      : drag/drop or paste box
//   - preview    : we parsed the CSV client-side, showing first 25 rows
//                  with column inference + per-row validation status
//   - submitting : POST to /api/targets/import-csv
//   - done       : show summary + per-row outcomes
//
// Client-side parsing means the user can see + fix issues before the
// network round-trip. Server-side re-parses on submit (we don't trust
// the client) so the contract is safe either way.

interface ParsedRow {
  raw: Record<string, string>;
  row_index: number;
  errors: string[];
}

interface ImportResult {
  ok: boolean;
  summary?: {
    total: number;
    parsed: number;
    pre_validation_errored: number;
    created: number;
    updated: number;
    rpc_errored: number;
  };
  validation_errors?: Array<{ row_index: number; error: string }>;
  results?: Array<{
    input_index: number;
    external_id: string | null;
    target_id: string | null;
    action: 'created' | 'updated' | 'error';
    error: string | null;
  }>;
  error?: string;
}

const REQUIRED_COLS = ['name', 'type', 'value'] as const;
const VALID_TYPES = new Set([
  'local_code',
  'repository',
  'web_application',
  'domain',
  'ip_address',
  'api',
  'container_image',
  'cloud_account',
]);
const VALID_FREQS = new Set(['manual', 'daily', 'weekly', 'monthly']);

export default function ImportCsvPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[] | null>(null);
  const [defaultProjectSlug, setDefaultProjectSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-parse whenever the text changes.
  useEffect(() => {
    if (!csvText.trim()) {
      setParsedRows(null);
      return;
    }
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    if (parsed.errors.length > 0) {
      setError(
        parsed.errors
          .slice(0, 3)
          .map((e) => `row ${e.row ?? '?'}: ${e.message}`)
          .join('; '),
      );
      setParsedRows(null);
      return;
    }
    setError(null);
    const rows: ParsedRow[] = parsed.data.map((raw, i) => {
      const errs: string[] = [];
      for (const c of REQUIRED_COLS) {
        if (!raw[c]?.trim()) errs.push(`missing ${c}`);
      }
      if (raw.type && !VALID_TYPES.has(raw.type.trim())) {
        errs.push(`unknown type "${raw.type}"`);
      }
      if (raw.scan_frequency && !VALID_FREQS.has(raw.scan_frequency.trim())) {
        errs.push(`invalid scan_frequency "${raw.scan_frequency}"`);
      }
      return { raw, row_index: i + 1, errors: errs };
    });
    setParsedRows(rows);
  }, [csvText]);

  async function onFile(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      setError('CSV exceeds 5MB');
      return;
    }
    const text = await file.text();
    setCsvText(text);
    setResult(null);
  }

  async function submit() {
    if (!csvText.trim()) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const qs = defaultProjectSlug.trim()
        ? `?project_slug=${encodeURIComponent(defaultProjectSlug.trim())}`
        : '';
      const res = await fetch(`/api/targets/import-csv${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: csvText,
      });
      const body = (await res.json().catch(() => ({}))) as ImportResult;
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Import failed.');
        setResult(body);
        return;
      }
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const validRowCount = (parsedRows ?? []).filter((r) => r.errors.length === 0).length;
  const errorRowCount = (parsedRows ?? []).filter((r) => r.errors.length > 0).length;

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/targets" className="transition-colors hover:text-neutral-300">
          Targets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Import from CSV</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Bulk import from CSV</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Drop a CSV exported from your CMDB, Terraform state, or asset inventory.
          We parse it client-side so you can preview + fix errors before submitting.
          Re-importing the same file is a no-op as long as you set the{' '}
          <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px]">
            external_id
          </code>{' '}
          column with stable identifiers.
        </p>
      </header>

      {/* Schema callout */}
      <details className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 text-sm">
        <summary className="cursor-pointer text-neutral-300">
          <FileText className="mr-1.5 inline h-3.5 w-3.5" strokeWidth={2.25} />
          Expected columns
        </summary>
        <table className="mt-3 w-full text-[11.5px]">
          <thead className="text-neutral-500">
            <tr className="border-b border-neutral-800">
              <th className="py-1.5 text-left font-medium">Column</th>
              <th className="py-1.5 text-left font-medium">Required</th>
              <th className="py-1.5 text-left font-medium">Notes</th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            <SchemaRow col="name" required notes="Display name shown in the UI" />
            <SchemaRow col="type" required notes="repository | web_application | api | container_image | cloud_account | domain | ip_address | local_code" />
            <SchemaRow col="value" required notes="Canonical identifier (URL, hostname, image:tag, provider/account)" />
            <SchemaRow col="external_id" notes="Stable id from your CMDB. Re-imports are idempotent on this." />
            <SchemaRow col="description" notes="Free-text" />
            <SchemaRow col="scan_frequency" notes="manual | daily | weekly | monthly (default: weekly)" />
            <SchemaRow col="project_slug" notes="Per-row project attachment. Overrides the default-project field below." />
            <SchemaRow col="tags" notes="Comma-separated; lands under metadata.tags" />
            <SchemaRow col="<any other>" notes="Unknown columns are forwarded into metadata so your CMDB cols survive" />
          </tbody>
        </table>
      </details>

      {/* Input */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-neutral-600"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={2.5} />
            Choose CSV file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
          <span className="text-[11px] text-neutral-500">or paste CSV text below</span>
          <span className="ml-auto flex items-center gap-2">
            <label htmlFor="default-project" className="text-[11px] text-neutral-400">
              Default project slug (optional):
            </label>
            <input
              id="default-project"
              type="text"
              value={defaultProjectSlug}
              onChange={(e) => setDefaultProjectSlug(e.target.value.toLowerCase())}
              placeholder="payments"
              className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            />
          </span>
        </div>

        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={6}
          placeholder={`name,type,value,external_id,scan_frequency,project_slug
Payments API,repository,https://github.com/acme/payments-api,cmdb-pa-001,weekly,payments
Public site,web_application,https://acme.com,cmdb-ws-002,daily,marketing
`}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
        />

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2.25} />
            <span>{error}</span>
          </div>
        )}
      </section>

      {/* Preview */}
      {parsedRows && parsedRows.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <Eye className="h-3 w-3" strokeWidth={2.25} />
              Preview · {parsedRows.length} row{parsedRows.length === 1 ? '' : 's'}
            </h2>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
                {validRowCount} valid
              </span>
              {errorRowCount > 0 && (
                <span className="inline-flex items-center gap-1 text-rose-300">
                  <AlertCircle className="h-3 w-3" strokeWidth={2.25} />
                  {errorRowCount} error{errorRowCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/30">
            <table className="w-full text-[11.5px]">
              <thead className="border-b border-neutral-800 bg-neutral-950/40 text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">name</th>
                  <th className="px-3 py-2 text-left font-medium">type</th>
                  <th className="px-3 py-2 text-left font-medium">value</th>
                  <th className="px-3 py-2 text-left font-medium">external_id</th>
                  <th className="px-3 py-2 text-left font-medium">project</th>
                  <th className="px-3 py-2 text-left font-medium">freq</th>
                  <th className="px-3 py-2 text-left font-medium">status</th>
                </tr>
              </thead>
              <tbody>
                {parsedRows.slice(0, 25).map((r) => (
                  <tr
                    key={r.row_index}
                    className={`border-b border-neutral-800/40 ${r.errors.length > 0 ? 'bg-rose-500/[0.04]' : ''}`}
                  >
                    <td className="px-3 py-1.5 font-mono text-neutral-500">{r.row_index}</td>
                    <td className="px-3 py-1.5">{r.raw.name}</td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px]">{r.raw.type}</td>
                    <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">{r.raw.value}</td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">{r.raw.external_id ?? '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">{r.raw.project_slug ?? defaultProjectSlug ?? '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px] text-neutral-400">{r.raw.scan_frequency ?? 'weekly'}</td>
                    <td className="px-3 py-1.5">
                      {r.errors.length === 0 ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
                          valid
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-rose-300"
                          title={r.errors.join('; ')}
                        >
                          <AlertCircle className="h-3 w-3" strokeWidth={2.25} />
                          {r.errors[0]}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsedRows.length > 25 && (
              <p className="border-t border-neutral-800/60 px-3 py-2 text-[11px] text-neutral-500">
                + {parsedRows.length - 25} more rows — all will be submitted.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={submitting || validRowCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 disabled:opacity-50"
            >
              {submitting ? 'Importing…' : `Import ${parsedRows.length} target${parsedRows.length === 1 ? '' : 's'}`}
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
            {errorRowCount > 0 && (
              <span className="text-[11px] text-amber-300">
                {errorRowCount} row{errorRowCount === 1 ? ' has an' : 's have'} error{errorRowCount === 1 ? '' : 's'} —
                those will be reported back per-row but the rest will still import.
              </span>
            )}
          </div>
        </section>
      )}

      {/* Result */}
      {result?.summary && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Result
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ResultStat label="Created" value={result.summary.created} tone="emerald" />
            <ResultStat label="Updated" value={result.summary.updated} tone="cyan" />
            <ResultStat
              label="Errored"
              value={
                result.summary.rpc_errored + (result.summary.pre_validation_errored ?? 0)
              }
              tone="rose"
            />
            <ResultStat label="Total" value={result.summary.total} tone="neutral" />
          </div>

          {result.results && result.results.some((r) => r.action === 'error') && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-3 text-xs">
              <p className="mb-2 font-semibold text-rose-200">Per-row errors:</p>
              <ul className="space-y-1 text-rose-200">
                {result.results
                  .filter((r) => r.action === 'error')
                  .slice(0, 10)
                  .map((r) => (
                    <li key={r.input_index} className="font-mono text-[10.5px]">
                      row {r.input_index}: {r.error}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/targets')}
              className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950"
            >
              View targets
            </button>
            <button
              type="button"
              onClick={() => {
                setCsvText('');
                setResult(null);
                setParsedRows(null);
              }}
              className="rounded-md border border-neutral-700 bg-neutral-900/40 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-600"
            >
              Import another
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SchemaRow({
  col,
  required,
  notes,
}: {
  col: string;
  required?: boolean;
  notes: string;
}) {
  return (
    <tr className="border-b border-neutral-800/40">
      <td className="py-1 pr-3 font-mono text-[10.5px] text-cyan-200">{col}</td>
      <td className="py-1 pr-3">
        {required ? (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-rose-300">
            yes
          </span>
        ) : (
          <span className="text-[10.5px] text-neutral-500">no</span>
        )}
      </td>
      <td className="py-1 text-neutral-400">{notes}</td>
    </tr>
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
