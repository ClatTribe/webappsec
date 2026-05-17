'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Play,
  Power,
  Radio,
  ExternalLink,
  Clock,
} from 'lucide-react';
import type { CollectorCatalogEntry } from '@/lib/evidence-collectors/registry';

interface CollectorConfig {
  id: string;
  collector_id: string;
  integration_id: string | null;
  enabled: boolean;
  frequency_minutes: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_run_evidence_count: number | null;
  created_at: string;
}

interface IntegrationRow {
  id: string;
  type: string;
  name: string;
  status: string;
}

interface RunRow {
  id: string;
  collector_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  evidence_count: number;
  error_message: string | null;
  produced_frameworks: string[];
}

interface Props {
  catalog: CollectorCatalogEntry[];
  initialConfigs: CollectorConfig[];
  integrations: IntegrationRow[];
  recentRuns: RunRow[];
}

const FRAMEWORK_LABEL: Record<string, string> = {
  soc_2: 'SOC 2',
  iso_27001: 'ISO 27001',
  pci_dss: 'PCI',
  hipaa: 'HIPAA',
  nist_800_53: 'NIST',
  cis_aws: 'CIS AWS',
  cis_kubernetes: 'CIS K8s',
};

export default function CollectorsClient({
  catalog,
  initialConfigs,
  integrations,
  recentRuns,
}: Props) {
  const [configs, setConfigs] = useState<Map<string, CollectorConfig>>(
    () => new Map(initialConfigs.map((c) => [c.collector_id, c])),
  );
  const [runs, setRuns] = useState<RunRow[]>(recentRuns);

  const upsertConfig = (c: CollectorConfig) => {
    setConfigs((prev) => {
      const next = new Map(prev);
      next.set(c.collector_id, c);
      return next;
    });
  };

  const onRunComplete = (run: RunRow) => {
    setRuns((prev) => [run, ...prev].slice(0, 50));
  };

  return (
    <div className="space-y-6">
      <ul className="space-y-3">
        {catalog.map((entry) => (
          <CollectorCard
            key={entry.id}
            entry={entry}
            config={configs.get(entry.id) ?? null}
            integrations={integrations}
            onConfigChange={upsertConfig}
            onRunComplete={onRunComplete}
          />
        ))}
      </ul>

      {runs.length > 0 && <RecentRunsTable runs={runs} />}
    </div>
  );
}

// ============== Collector card ====================================

function CollectorCard({
  entry,
  config,
  integrations,
  onConfigChange,
  onRunComplete,
}: {
  entry: CollectorCatalogEntry;
  config: CollectorConfig | null;
  integrations: IntegrationRow[];
  onConfigChange: (c: CollectorConfig) => void;
  onRunComplete: (r: RunRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enabled = config?.enabled ?? false;

  const eligibleIntegrations = integrations.filter((i) => i.type === entry.integration_type);

  const toggle = async () => {
    if (busy) return;
    if (!enabled && !config?.integration_id && eligibleIntegrations.length === 0) {
      setErr(
        `No active ${entry.integration_type} integration in this org. Connect one in Integrations → New → ${entry.integration_type} first.`,
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const integration_id =
        config?.integration_id ?? eligibleIntegrations[0]?.id ?? null;
      const res = await fetch(`/api/evidence-collectors/${entry.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: !enabled,
          integration_id,
          frequency_minutes: config?.frequency_minutes ?? entry.default_frequency_minutes,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      onConfigChange({
        ...(config ?? {
          id: json.config.id,
          collector_id: entry.id,
          integration_id,
          enabled: !enabled,
          frequency_minutes: entry.default_frequency_minutes,
          last_run_at: null,
          last_run_status: null,
          last_run_error: null,
          last_run_evidence_count: null,
          created_at: new Date().toISOString(),
        }),
        ...json.config,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  };

  const changeIntegration = async (integrationId: string) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/evidence-collectors/${entry.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ integration_id: integrationId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      if (config) onConfigChange({ ...config, ...json.config });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (busy || !enabled) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/evidence-collectors/${entry.id}/run`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      // Optimistically reflect in the card + prepend a run row.
      const nowIso = new Date().toISOString();
      if (config) {
        onConfigChange({
          ...config,
          last_run_at: nowIso,
          last_run_status: json.status,
          last_run_error: json.error_message,
          last_run_evidence_count: json.evidence_count,
        });
      }
      onRunComplete({
        id: `local-${Date.now()}`,
        collector_id: entry.id,
        started_at: nowIso,
        finished_at: nowIso,
        status: json.status,
        evidence_count: json.evidence_count,
        error_message: json.error_message,
        produced_frameworks: json.produced_frameworks ?? [],
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`rounded-2xl border p-5 ${
        enabled
          ? 'border-emerald-500/20 bg-emerald-500/[0.03]'
          : 'border-neutral-800/80 bg-neutral-900/30'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <Radio
              className={`h-4 w-4 ${enabled ? 'text-emerald-300' : 'text-neutral-500'}`}
              strokeWidth={2.25}
            />
            <h2 className="text-base font-semibold text-neutral-100">{entry.display_name}</h2>
            <span className="rounded-md bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
              {entry.id}
            </span>
            {enabled && (
              <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/30">
                active
              </span>
            )}
          </div>
          <p className="text-[12px] leading-relaxed text-neutral-400">{entry.description}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[10.5px] text-neutral-500">
            <span>
              <strong className="text-neutral-300">{entry.controls_emitted}</strong> controls credited
            </span>
            <span>·</span>
            <span>
              Polls every <strong className="text-neutral-300">{config?.frequency_minutes ?? entry.default_frequency_minutes}m</strong>
            </span>
            <span>·</span>
            <span>
              Uses{' '}
              <strong className="text-neutral-300">{entry.integration_type}</strong> integration
            </span>
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium ring-1 ${
              enabled
                ? 'bg-neutral-800 text-neutral-200 ring-neutral-700 hover:bg-neutral-700'
                : 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30 hover:bg-emerald-500/25'
            } disabled:opacity-50`}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
            ) : (
              <Power className="h-3 w-3" strokeWidth={2.5} />
            )}
            {enabled ? 'Disable' : 'Enable'}
          </button>
          {enabled && (
            <button
              type="button"
              onClick={runNow}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
            >
              <Play className="h-2.5 w-2.5" strokeWidth={2.5} />
              Run now
            </button>
          )}
        </div>
      </div>

      {enabled && (
        <div className="mt-3 space-y-2 border-t border-neutral-800/60 pt-3">
          {/* Integration picker */}
          {eligibleIntegrations.length > 1 ? (
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Integration
              </span>
              <select
                value={config?.integration_id ?? ''}
                onChange={(e) => changeIntegration(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100"
              >
                {eligibleIntegrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            config?.integration_id && (
              <div className="text-[11px] text-neutral-500">
                Using integration:{' '}
                <span className="font-mono text-neutral-300">
                  {eligibleIntegrations.find((i) => i.id === config.integration_id)?.name ??
                    config.integration_id.slice(0, 8)}
                </span>
              </div>
            )
          )}

          {/* Last run status */}
          {config?.last_run_at && <LastRunBadge config={config} />}
        </div>
      )}

      {!enabled && eligibleIntegrations.length === 0 && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.04] px-3 py-2 text-[11.5px] text-amber-200/80">
          <AlertTriangle className="mr-1 inline h-3 w-3" strokeWidth={2.5} />
          No active <strong>{entry.integration_type}</strong> integration in this org.{' '}
          <Link
            href={`/integrations/new/${entry.integration_type}`}
            className="underline-offset-2 hover:underline"
          >
            Connect one
          </Link>{' '}
          first.
        </div>
      )}

      {err && (
        <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
          {err}
        </div>
      )}
    </li>
  );
}

function LastRunBadge({ config }: { config: CollectorConfig }) {
  const status = config.last_run_status;
  const tone =
    status === 'success'
      ? 'text-emerald-200 bg-emerald-500/15 ring-emerald-400/30'
      : status === 'partial'
        ? 'text-amber-200 bg-amber-500/15 ring-amber-400/30'
        : status === 'error'
          ? 'text-rose-200 bg-rose-500/15 ring-rose-400/30'
          : 'text-neutral-300 bg-neutral-800/80 ring-neutral-700';
  const Icon =
    status === 'success' ? CheckCircle2 : status === 'error' ? XCircle : AlertCircle;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 ${tone}`}>
        <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
        {status ?? 'unknown'}
      </span>
      <span className="text-neutral-500">
        <Clock className="mr-0.5 inline h-2.5 w-2.5" strokeWidth={2.5} />
        {config.last_run_at ? new Date(config.last_run_at).toLocaleString() : '—'}
      </span>
      {typeof config.last_run_evidence_count === 'number' && (
        <span className="text-neutral-500">
          {config.last_run_evidence_count} evidence row{config.last_run_evidence_count === 1 ? '' : 's'}
        </span>
      )}
      {config.last_run_error && (
        <span className="text-rose-300/80" title={config.last_run_error}>
          {truncate(config.last_run_error, 80)}
        </span>
      )}
    </div>
  );
}

// ============== Recent runs table =================================

function RecentRunsTable({ runs }: { runs: RunRow[] }) {
  return (
    <section className="space-y-2 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-300">
        Recent runs
      </h2>
      <p className="text-[11px] text-neutral-500">
        Append-only audit log. Auditors read this to demonstrate continuous evidence collection cadence.
      </p>
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            <th className="py-1.5">Collector</th>
            <th className="py-1.5">Started</th>
            <th className="py-1.5">Status</th>
            <th className="py-1.5">Evidence</th>
            <th className="py-1.5">Frameworks</th>
            <th className="py-1.5">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/60">
          {runs.map((r) => (
            <tr key={r.id} className="text-neutral-300">
              <td className="py-2 font-mono text-[10.5px]">{r.collector_id}</td>
              <td className="py-2 text-neutral-500">{new Date(r.started_at).toLocaleString()}</td>
              <td className="py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    r.status === 'success'
                      ? 'bg-emerald-500/15 text-emerald-200'
                      : r.status === 'partial'
                        ? 'bg-amber-500/15 text-amber-200'
                        : r.status === 'error'
                          ? 'bg-rose-500/15 text-rose-200'
                          : 'bg-neutral-800 text-neutral-400'
                  }`}
                >
                  {r.status}
                </span>
              </td>
              <td className="py-2">{r.evidence_count}</td>
              <td className="py-2">
                <span className="flex flex-wrap gap-1">
                  {(r.produced_frameworks ?? []).map((f) => (
                    <span key={f} className="rounded bg-neutral-800/80 px-1 py-0.5 text-[10px]">
                      {FRAMEWORK_LABEL[f] ?? f}
                    </span>
                  ))}
                </span>
              </td>
              <td className="py-2 text-rose-300/80">
                {r.error_message ? truncate(r.error_message, 60) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pt-2 text-[10.5px] text-neutral-500">
        <ExternalLink className="mr-1 inline h-2.5 w-2.5" strokeWidth={2.5} />
        Cron: <code className="rounded bg-neutral-800/80 px-1 py-0.5">POST /api/cron/evidence-collectors</code> (Authorization: Bearer $CRON_SECRET)
      </div>
    </section>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
