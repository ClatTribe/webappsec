import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  FolderKanban,
  Plus,
  AlertCircle,
  AlertTriangle,
  ShieldCheck,
  Clock,
  ChevronRight,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Projects',
};

interface ProjectSummary {
  project_id: string;
  slug: string;
  name: string;
  criticality: 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4';
  owner_user_id: string | null;
  tags: Record<string, unknown> | null;
  target_count: number;
  last_scan_at: string | null;
  open_critical: number;
  open_high: number;
  open_medium: number;
  open_low: number;
  open_total: number;
}

// Phase C — projects index.
// Per-org grouping of related targets. Auditors filter compliance by
// project; AppSec engineers route findings by project owner; everyone
// thinks in services, not flat target rows.

export default async function ProjectsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: projects } = (await supabase
    .from('project_summary_v')
    .select(
      'project_id, slug, name, criticality, owner_user_id, tags, archived_at, target_count, last_scan_at, open_critical, open_high, open_medium, open_low, open_total',
    )
    .is('archived_at', null)
    .order('criticality', { ascending: true })
    .order('open_critical', { ascending: false })) as unknown as {
    data: ProjectSummary[] | null;
  };

  const rows = projects ?? [];

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <FolderKanban className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
            <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
          </div>
          <p className="max-w-2xl text-sm text-neutral-400">
            Group related targets into a project so findings, compliance posture,
            and ownership roll up one level above the flat target list. Set
            criticality so urgent findings on tier-1 projects float to the top.
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-1.5 self-start rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-2 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New project
        </Link>
      </header>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <ProjectCard key={p.project_id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const tags =
    project.tags && typeof project.tags === 'object'
      ? (Object.entries(project.tags) as Array<[string, unknown]>)
      : [];
  return (
    <Link
      href={`/projects/${project.slug}`}
      className="group flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">
            {project.name}
          </h3>
          <p className="font-mono text-[10px] text-neutral-500">{project.slug}</p>
        </div>
        <CriticalityChip criticality={project.criticality} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <Stat
          icon={AlertCircle}
          tone="rose"
          label="Critical"
          value={project.open_critical}
        />
        <Stat
          icon={AlertTriangle}
          tone="amber"
          label="High"
          value={project.open_high}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-500">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
          {project.target_count} target{project.target_count === 1 ? '' : 's'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3" strokeWidth={2.25} />
          {project.last_scan_at
            ? new Date(project.last_scan_at).toLocaleDateString()
            : 'never scanned'}
        </span>
      </div>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {tags.slice(0, 4).map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-300"
            >
              {k}
              {v != null ? `:${String(v)}` : ''}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 inline-flex items-center gap-1 self-end text-[10.5px] text-neutral-500 transition-colors group-hover:text-cyan-300">
        Open
        <ChevronRight className="h-3 w-3" strokeWidth={2.5} />
      </div>
    </Link>
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
      className={`inline-flex flex-shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${t.cls}`}
    >
      {t.label}
    </span>
  );
}

function Stat({
  icon: Icon,
  tone,
  label,
  value,
}: {
  icon: typeof AlertCircle;
  tone: 'rose' | 'amber';
  label: string;
  value: number;
}) {
  const color = {
    rose: 'text-rose-300',
    amber: 'text-amber-300',
  }[tone];
  return (
    <div className="flex items-center gap-2 rounded-md bg-neutral-950/40 px-2 py-1.5">
      <Icon className={`h-3 w-3 ${color}`} strokeWidth={2.25} />
      <span className="text-neutral-400">{label}</span>
      <span className={`ml-auto font-semibold ${value > 0 ? color : 'text-neutral-500'}`}>
        {value}
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-10 text-center">
      <FolderKanban className="mx-auto h-8 w-8 text-neutral-600" strokeWidth={1.5} />
      <h2 className="mt-4 text-base font-semibold text-white">
        Group your targets into projects
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
        Once you have a handful of targets, projects let you ask &quot;how&apos;s the
        payments service doing?&quot; instead of staring at a flat list. Findings,
        compliance posture, and last-scan recency all roll up to the project
        level.
      </p>
      <Link
        href="/projects/new"
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-950"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        Create your first project
      </Link>
    </div>
  );
}
