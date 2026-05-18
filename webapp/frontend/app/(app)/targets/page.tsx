import Link from 'next/link';
import {
  Plus,
  Target as TargetIcon,
  Code2,
  Globe,
  Server,
  Folder,
  Network,
  Plug,
  Clock,
  Container,
  Cloud,
} from 'lucide-react';
import DormantTargetsClient from './dormant-targets-client';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import type { Target, TargetType } from '@/lib/supabase/types';

const TYPE_ICON: Record<TargetType, LucideIcon> = {
  repository: Code2,
  web_application: Globe,
  api: Plug,
  container_image: Container,
  cloud_account: Cloud,
  domain: Globe,
  ip_address: Network,
  local_code: Folder,
};

interface Stats {
  total_scans: number;
  open_findings: number;
  urgent: number;
  last_scan_at: string | null;
}

export default async function TargetsPage() {
  const supabase = createClient();

  const { data: targets } = await supabase
    .from('targets')
    .select('*')
    .eq('status', 'active')
    .order('last_scan_at', { ascending: false, nullsFirst: false });

  // Phase F — dormant targets the sweep cron flagged. Surface them in
  // a collapsible section under the active list so the customer can
  // batch-review/restore/archive them without leaving the targets page.
  const { data: dormantTargets } = (await supabase
    .from('targets')
    .select('id, name, type, value, dormancy_reason, dormancy_detected_at, last_scan_at')
    .eq('status', 'dormant')
    .order('dormancy_detected_at', { ascending: false })) as unknown as {
    data: Array<{
      id: string;
      name: string;
      type: string;
      value: string;
      dormancy_reason: string | null;
      dormancy_detected_at: string | null;
      last_scan_at: string | null;
    }> | null;
  };

  // Phase C — pull project lookup so the cards can render a project
  // chip per row. Cheap: one extra read for the whole projects list,
  // hashed by id for O(1) lookup at render time.
  const { data: projectRows } = (await supabase
    .from('projects')
    .select('id, slug, name, criticality')
    .is('archived_at', null)) as unknown as {
    data: Array<{
      id: string;
      slug: string;
      name: string;
      criticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4';
    }> | null;
  };
  const projectById = Object.fromEntries(
    (projectRows ?? []).map((p) => [p.id, p]),
  );

  // Aggregate stats per target. Two cheap queries instead of N.
  const targetIds = (targets ?? []).map((t) => t.id);
  let stats: Record<string, Stats> = {};
  if (targetIds.length > 0) {
    const [{ data: scanRows }, { data: findingRows }] = await Promise.all([
      supabase
        .from('scans')
        .select('target_id, finished_at, status')
        .in('target_id', targetIds),
      supabase
        .from('findings')
        .select('target_id, status, severity, ai_assessment')
        .in('target_id', targetIds),
    ]);

    stats = Object.fromEntries(
      targetIds.map((id) => [
        id,
        { total_scans: 0, open_findings: 0, urgent: 0, last_scan_at: null } as Stats,
      ]),
    );
    for (const s of scanRows ?? []) {
      const st = stats[s.target_id as string];
      if (!st) continue;
      st.total_scans++;
    }
    for (const f of findingRows ?? []) {
      const st = stats[f.target_id as string];
      if (!st) continue;
      const resolved = ['fixed', 'false_positive', 'wont_fix'].includes(f.status as string);
      if (resolved) continue;
      st.open_findings++;
      const u = (f.ai_assessment as { urgency?: string } | null)?.urgency;
      if (u === 'fix_now' || u === 'fix_soon') st.urgent++;
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Targets</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-neutral-400">
            Each target is an asset you scan repeatedly — a repo, a deployed app, a domain.
            Findings, scan history, and triage state all roll up per target.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Phase D — bulk CSV import for orgs with an existing CMDB /
              Terraform state / spreadsheet inventory. Idempotent
              re-import via external_id; per-row outcomes surface
              created/updated/errored separately. */}
          <Link
            href="/targets/import-csv"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900/40 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800/60"
          >
            Import from CSV
          </Link>
          {/* Phase B #3 — bulk import from GitHub. Renders next to the
              singleton "Add target" button so users with a connected
              GitHub integration see the fast path. The link works
              regardless of integration state — the destination page
              shows a "connect first" CTA if none are wired. */}
          <Link
            href="/targets/import-github"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900/40 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800/60"
          >
            Import from GitHub
          </Link>
          <Link
            href="/targets/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md hover:shadow-white/15"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Add target
          </Link>
        </div>
      </header>

      {targets && targets.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {targets.map((t: Target) => {
            const Icon = TYPE_ICON[t.type] ?? Server;
            const s = stats[t.id] ?? { total_scans: 0, open_findings: 0, urgent: 0, last_scan_at: null };
            return (
              <Link
                key={t.id}
                href={`/targets/${t.id}`}
                className="group relative overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5 transition-all hover:border-neutral-700 hover:bg-neutral-900/50"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
                    <Icon className="h-4 w-4" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-neutral-50">
                        {t.name}
                      </h3>
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-neutral-400">
                        {t.type}
                      </span>
                      {/* Phase C — project chip. Clicking jumps to the
                          project detail page. We render NOTHING when the
                          target isn't attached so the row looks identical
                          to pre-migration-078. */}
                      {((t as Target & { project_id?: string | null }).project_id) &&
                        projectById[(t as Target & { project_id: string }).project_id] && (
                          <span
                            className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-violet-200 ring-1 ring-violet-500/30"
                            title={`Project: ${projectById[(t as Target & { project_id: string }).project_id].name}`}
                          >
                            {projectById[(t as Target & { project_id: string }).project_id].slug}
                          </span>
                        )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11.5px] text-neutral-400">
                      {t.value}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-neutral-400">
                      <span>
                        <span className="font-semibold text-neutral-100">{s.total_scans}</span>{' '}
                        scan{s.total_scans === 1 ? '' : 's'}
                      </span>
                      <span>
                        <span className="font-semibold text-neutral-100">{s.open_findings}</span>{' '}
                        open
                      </span>
                      {s.urgent > 0 && (
                        <span className="rounded-md bg-red-500/15 px-1.5 py-0.5 font-semibold text-red-300 ring-1 ring-red-500/30">
                          {s.urgent} urgent
                        </span>
                      )}
                      <span className="ml-auto inline-flex flex-col items-end gap-0.5 text-neutral-500">
                        <span>
                          {t.last_scan_at
                            ? `Last scanned ${new Date(t.last_scan_at).toLocaleDateString()}`
                            : 'Never scanned'}
                        </span>
                        {/* Phase B #2 — surface scheduled cadence. The
                            worker's `scheduled_scan_loop` (migration 050)
                            fires `worker_enqueue_scheduled_scans` every
                            tick; the next scan lands within the
                            cadence window of the last scan. We surface
                            cadence directly rather than computing an
                            exact next-run timestamp because the
                            scheduling RPC checks `last_scan_at <
                            now() - cadence`. */}
                        {t.scan_frequency && t.scan_frequency !== 'manual' && (
                          <span className="inline-flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 font-medium text-cyan-200 ring-1 ring-cyan-400/20">
                            <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                            {t.scan_frequency}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/20 px-8 py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900 ring-1 ring-neutral-800">
            <TargetIcon className="h-6 w-6 text-neutral-500" strokeWidth={1.75} />
          </div>
          <h3 className="mt-4 text-base font-medium text-neutral-200">No targets yet</h3>
          <p className="mt-1 max-w-sm text-sm text-neutral-500 mx-auto">
            Add a repo, app, or domain you want to scan repeatedly. All scans and findings will
            roll up here.
          </p>
          <Link
            href="/targets/new"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-200"
          >
            <Plus className="h-4 w-4" />
            Add your first target
          </Link>
        </div>
      )}

      {/* Phase F — dormant assets. Only renders when the sweep flagged
          something; quiet teams see nothing. The client component
          handles the restore/archive bulk actions to keep this server
          page minimal. */}
      {dormantTargets && dormantTargets.length > 0 && (
        <DormantTargetsClient targets={dormantTargets} />
      )}
    </div>
  );
}
