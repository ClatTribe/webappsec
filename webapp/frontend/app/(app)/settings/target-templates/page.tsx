import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ChevronRight,
  Layers,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Settings · Target templates',
};

interface TemplateRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  asset_type: string | null;
  config: Record<string, unknown>;
  tags: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Phase B — target templates index.
// Per-org config templates a target can inherit. Edits propagate via
// the effective_target_config_v view (no backfill).

export default async function TargetTemplatesPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: templates } = (await supabase
    .from('target_templates')
    .select('id, name, slug, description, asset_type, config, tags, created_at, updated_at')
    .is('archived_at', null)
    .order('asset_type', { ascending: true, nullsFirst: true })
    .order('name')) as unknown as { data: TemplateRow[] | null };

  // Per-template usage count, batched.
  const ids = (templates ?? []).map((t) => t.id);
  let usageById: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: counts } = (await supabase
      .from('targets')
      .select('template_id')
      .in('template_id', ids)) as unknown as {
      data: Array<{ template_id: string }> | null;
    };
    for (const r of counts ?? []) {
      usageById[r.template_id] = (usageById[r.template_id] ?? 0) + 1;
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Target templates</span>
      </nav>

      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
            <h1 className="text-3xl font-semibold tracking-tight">
              Target templates
            </h1>
          </div>
          <p className="max-w-2xl text-sm text-neutral-400">
            Reusable scan config you can attach to many targets at once.
            &quot;Prod web apps&quot; can hold the shared cadence, auth method,
            exclude paths, and rate limits — attach 50 targets and they all
            inherit. Edits propagate to attached targets on next scan dispatch.
          </p>
        </div>
        <Link
          href="/settings/target-templates/new"
          className="inline-flex items-center gap-1.5 self-start rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-2 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New template
        </Link>
      </header>

      {(templates?.length ?? 0) === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates!.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              targetCount={usageById[t.id] ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  targetCount,
}: {
  template: TemplateRow;
  targetCount: number;
}) {
  const configKeys = Object.keys(template.config ?? {});
  return (
    <Link
      href={`/settings/target-templates/${template.slug}`}
      className="group flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">
            {template.name}
          </h3>
          <p className="font-mono text-[10px] text-neutral-500">
            {template.slug}
          </p>
        </div>
        {template.asset_type && (
          <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-500/30">
            {template.asset_type}
          </span>
        )}
      </div>

      {template.description && (
        <p className="mt-2 line-clamp-2 text-[12.5px] text-neutral-400">
          {template.description}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 text-[11px] text-neutral-500">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
          {targetCount} target{targetCount === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>
          {configKeys.length} config key{configKeys.length === 1 ? '' : 's'}
        </span>
      </div>

      {configKeys.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {configKeys.slice(0, 4).map((k) => (
            <span
              key={k}
              className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-300"
            >
              {k}
            </span>
          ))}
          {configKeys.length > 4 && (
            <span className="text-[10px] text-neutral-500">
              + {configKeys.length - 4}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-10 text-center">
      <Layers className="mx-auto h-8 w-8 text-neutral-600" strokeWidth={1.5} />
      <h2 className="mt-4 text-base font-semibold text-white">
        No templates yet
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
        Once you have 5+ targets that share the same scan config (cadence,
        auth method, exclude paths), creating a template lets you stop
        re-typing it.
      </p>
      <Link
        href="/settings/target-templates/new"
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-950"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        Create your first template
      </Link>
    </div>
  );
}
