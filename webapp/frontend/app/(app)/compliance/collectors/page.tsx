import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Radio, ChevronRight, Database } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import CollectorsClient from './collectors-client';
import { listCatalog } from '@/lib/evidence-collectors/registry';

// Continuous evidence collectors dashboard.
//
// /compliance/collectors
//
// One row per collector in the catalog. Each row shows:
//   - definition (display name, description, controls credited)
//   - enable / disable toggle
//   - linked integration picker (when enabled)
//   - last-run status + evidence count
//   - "Run now" button (manual trigger)
//
// Server-renders the catalog + per-org state in one round-trip.

export const metadata = {
  title: 'Compliance · Continuous evidence collectors',
};

interface CollectorConfigRow {
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

export default async function CollectorsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Three parallel fetches.
  const [{ data: configs }, { data: integrations }, { data: recentRuns }] = await Promise.all([
    supabase
      .from('evidence_collectors')
      .select(
        'id, collector_id, integration_id, enabled, frequency_minutes, last_run_at, last_run_status, last_run_error, last_run_evidence_count, created_at',
      ),
    supabase
      .from('integrations')
      .select('id, type, name, status')
      .eq('status', 'active'),
    supabase
      .from('evidence_collector_runs')
      .select('id, collector_id, started_at, finished_at, status, evidence_count, error_message, produced_frameworks')
      .order('started_at', { ascending: false })
      .limit(50),
  ]);

  const catalog = listCatalog();
  const configMap = new Map<string, CollectorConfigRow>();
  for (const c of (configs ?? []) as CollectorConfigRow[]) {
    configMap.set(c.collector_id, c);
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <Link href="/compliance" className="transition-colors hover:text-neutral-300">
            Compliance
          </Link>
          <span>·</span>
          <span className="text-neutral-300">Continuous evidence</span>
        </nav>
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-emerald-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Continuous evidence collectors</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Auto-pull compliance evidence from the operational SaaS your team
          already uses. One observation in GitHub credits the equivalent
          control across SOC&nbsp;2, ISO&nbsp;27001, PCI, HIPAA, and NIST.
          Replaces "manually upload screenshots" with a continuous feed.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-neutral-500">
          <Link
            href="/compliance/readiness"
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-neutral-200 hover:underline"
          >
            <ChevronRight className="h-3 w-3 rotate-180" strokeWidth={2.5} />
            Audit-readiness scores
          </Link>
          <span>·</span>
          <span className="inline-flex items-center gap-1">
            <Database className="h-3 w-3" strokeWidth={2.5} />
            Evidence stored as <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-[10px]">compliance_evidence</code> rows with source=<code className="rounded bg-neutral-800/80 px-1 py-0.5 text-[10px]">collector:&lt;id&gt;</code>
          </span>
        </div>
      </header>

      <CollectorsClient
        catalog={catalog}
        initialConfigs={(configs ?? []) as CollectorConfigRow[]}
        integrations={(integrations ?? []) as Array<{ id: string; type: string; name: string; status: string }>}
        recentRuns={(recentRuns ?? []) as Array<{
          id: string;
          collector_id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          evidence_count: number;
          error_message: string | null;
          produced_frameworks: string[];
        }>}
      />
    </div>
  );
}
