import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderKanban,
  ShieldCheck,
  Code2,
  Globe,
  Server,
  Folder,
  Network,
  Plug,
  Container,
  Cloud,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import ProjectAttachClient from './project-attach-client';

interface ProjectSummary {
  project_id: string;
  slug: string;
  name: string;
  criticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4';
  owner_user_id: string | null;
  tags: Record<string, unknown> | null;
  archived_at: string | null;
  target_count: number;
  last_scan_at: string | null;
  open_critical: number;
  open_high: number;
  open_medium: number;
  open_low: number;
  open_total: number;
}

interface ProjectTarget {
  id: string;
  name: string;
  type: string;
  value: string;
  status: string;
  last_scan_at: string | null;
  scan_frequency: string;
}

const TYPE_ICON: Record<string, LucideIcon> = {
  repository: Code2,
  web_application: Globe,
  api: Plug,
  container_image: Container,
  cloud_account: Cloud,
  domain: Globe,
  ip_address: Network,
  local_code: Folder,
};

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}) {
  return { title: `Project · ${params.slug}` };
}

// Project detail — header rollup + target list. The attach-targets
// flow is delegated to a client component so the rest of the page
// stays server-rendered.

export default async function ProjectDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: project } = (await supabase
    .from('project_summary_v')
    .select(
      'project_id, slug, name, criticality, owner_user_id, tags, archived_at, target_count, last_scan_at, open_critical, open_high, open_medium, open_low, open_total',
    )
    .eq('slug', params.slug)
    .is('archived_at', null)
    .maybeSingle()) as unknown as { data: ProjectSummary | null };

  if (!project) notFound();

  const { data: targets } = (await supabase
    .from('targets')
    .select('id, name, type, value, status, last_scan_at, scan_frequency')
    .eq('project_id', project.project_id)
    .eq('status', 'active')
    .order('last_scan_at', {
      ascending: false,
      nullsFirst: false,
    })) as unknown as { data: ProjectTarget[] | null };

  // Pull per-target open-finding counts in one batched read.
  const targetIds = (targets ?? []).map((t) => t.id);
  const perTargetCounts: Record<
    string,
    { open_critical: number; open_high: number; open_total: number }
  > = {};
  if (targetIds.length > 0) {
    const { data: counts } = (await supabase
      .from('findings')
      .select('target_id, severity')
      .in('target_id', targetIds)
      .eq('status', 'open')) as unknown as {
      data: Array<{ target_id: string; severity: string }> | null;
    };
    for (const row of counts ?? []) {
      const bucket = (perTargetCounts[row.target_id] ??= {
        open_critical: 0,
        open_high: 0,
        open_total: 0,
      });
      bucket.open_total += 1;
      if (row.severity === 'critical') bucket.open_critical += 1;
      if (row.severity === 'high') bucket.open_high += 1;
    }
  }

  // Also fetch the org's unattached targets so the "attach more"
  // panel has something to populate from.
  const { data: unattachedTargets } = (await supabase
    .from('targets')
    .select('id, name, type, value')
    .is('project_id', null)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(200)) as unknown as {
    data: Array<{ id: string; name: string; type: string; value: string }> | null;
  };

  const tags =
    project.tags && typeof project.tags === 'object'
      ? (Object.entries(project.tags) as Array<[string, unknown]>)
      : [];

  return (
    <div className="max-w-6xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/projects" className="transition-colors hover:text-neutral-300">
          Projects
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">{project.name}</span>
      </nav>

      <header className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FolderKanban
                className="h-5 w-5 text-violet-300"
                strokeWidth={2.25}
              />
              <h1 className="text-2xl font-semibold tracking-tight">
                {project.name}
              </h1>
              <CriticalityChip criticality={project.criticality} />
            </div>
            <p className="font-mono text-[11px] text-neutral-500">
              {project.slug}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-neutral-500">
            <Clock className="h-3.5 w-3.5" />
            {project.last_scan_at
              ? `Last scan ${new Date(project.last_scan_at).toLocaleString()}`
              : 'No scans yet'}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <RollupStat
            icon={AlertCircle}
            tone="rose"
            label="Open critical"
            value={project.open_critical}
          />
          <RollupStat
            icon={AlertTriangle}
            tone="amber"
            label="Open high"
            value={project.open_high}
          />
          <RollupStat
            icon={ShieldCheck}
            tone="cyan"
            label="Targets"
            value={project.target_count}
          />
          <RollupStat
            icon={ShieldCheck}
            tone="neutral"
            label="All open findings"
            value={project.open_total}
          />
        </div>

        {tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map(([k, v]) => (
              <span
                key={k}
                className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
              >
                {k}
                {v != null ? `:${String(v)}` : ''}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Targets list */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Targets · {targets?.length ?? 0}
          </h2>
          <Link
            href={`/findings?project=${project.slug}`}
            className="text-[11px] text-cyan-300 hover:underline"
          >
            View findings →
          </Link>
        </div>
        {targets && targets.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/30">
            {targets.map((t, i) => {
              const Icon = TYPE_ICON[t.type] ?? Folder;
              const counts = perTargetCounts[t.id] ?? {
                open_critical: 0,
                open_high: 0,
                open_total: 0,
              };
              return (
                <Link
                  key={t.id}
                  href={`/assets/${t.id}`}
                  className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-900/50 ${
                    i < targets.length - 1 ? 'border-b border-neutral-800/60' : ''
                  }`}
                >
                  <Icon className="h-4 w-4 text-neutral-400" strokeWidth={2} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-neutral-100">
                        {t.name}
                      </span>
                      <span className="font-mono text-[9.5px] uppercase tracking-wider text-neutral-500">
                        {t.type}
                      </span>
                    </div>
                    <p className="truncate font-mono text-[10.5px] text-neutral-500">
                      {t.value}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    {counts.open_critical > 0 && (
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-300">
                        {counts.open_critical} crit
                      </span>
                    )}
                    {counts.open_high > 0 && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                        {counts.open_high} high
                      </span>
                    )}
                    {counts.open_total === 0 && (
                      <span className="text-neutral-500">no findings</span>
                    )}
                  </div>
                  <ExternalLink
                    className="h-3.5 w-3.5 text-neutral-600"
                    strokeWidth={2}
                  />
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-6 text-center text-sm text-neutral-500">
            No targets in this project yet. Use the panel below to attach some.
          </div>
        )}
      </section>

      {/* Attach unattached targets */}
      {(unattachedTargets?.length ?? 0) > 0 && (
        <ProjectAttachClient
          projectId={project.project_id}
          unattached={unattachedTargets ?? []}
        />
      )}
    </div>
  );
}

function CriticalityChip({
  criticality,
}: {
  criticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4';
}) {
  const t = {
    tier_1: { label: 'Tier 1', cls: 'bg-rose-500/10 text-rose-300 ring-rose-500/30' },
    tier_2: { label: 'Tier 2', cls: 'bg-amber-500/10 text-amber-300 ring-amber-500/30' },
    tier_3: { label: 'Tier 3', cls: 'bg-cyan-500/10 text-cyan-300 ring-cyan-500/30' },
    tier_4: { label: 'Tier 4', cls: 'bg-neutral-700/30 text-neutral-400 ring-neutral-600/40' },
  }[criticality];
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${t.cls}`}
    >
      {t.label}
    </span>
  );
}

function RollupStat({
  icon: Icon,
  tone,
  label,
  value,
}: {
  icon: LucideIcon;
  tone: 'rose' | 'amber' | 'cyan' | 'neutral';
  label: string;
  value: number;
}) {
  const color = {
    rose: 'text-rose-300',
    amber: 'text-amber-300',
    cyan: 'text-cyan-300',
    neutral: 'text-neutral-200',
  }[tone];
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-3">
      <Icon
        className={`h-3.5 w-3.5 ${tone === 'neutral' ? 'text-neutral-500' : color}`}
        strokeWidth={2.25}
      />
      <div className={`mt-1.5 text-2xl font-semibold ${value > 0 && tone !== 'neutral' ? color : 'text-neutral-200'}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
    </div>
  );
}
