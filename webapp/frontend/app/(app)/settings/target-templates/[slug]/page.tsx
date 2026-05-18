import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ChevronRight, Layers } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import TargetTemplateDetailClient from './target-template-detail-client';

export const metadata = {
  title: 'Settings · Target template',
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

interface AttachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
  status: string;
  last_scan_at: string | null;
}

export default async function TargetTemplateDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: template } = (await supabase
    .from('target_templates')
    .select('id, name, slug, description, asset_type, config, tags, created_at, updated_at')
    .eq('slug', params.slug)
    .is('archived_at', null)
    .maybeSingle()) as unknown as { data: TemplateRow | null };

  if (!template) notFound();

  const { data: attached } = (await supabase
    .from('targets')
    .select('id, name, type, value, status, last_scan_at')
    .eq('template_id', template.id)
    .order('name')) as unknown as { data: AttachedTarget[] | null };

  // Unattached targets eligible for attach (filtered by asset_type
  // when the template restricts).
  const q = supabase
    .from('targets')
    .select('id, name, type, value')
    .is('template_id', null)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(200);
  const { data: unattached } = (await (template.asset_type
    ? q.eq('type', template.asset_type)
    : q
  )) as unknown as { data: Array<{ id: string; name: string; type: string; value: string }> | null };

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link
          href="/settings/target-templates"
          className="transition-colors hover:text-neutral-300"
        >
          Target templates
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">{template.name}</span>
      </nav>

      <header className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
              <h1 className="text-2xl font-semibold tracking-tight">
                {template.name}
              </h1>
              {template.asset_type && (
                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-500/30">
                  {template.asset_type}
                </span>
              )}
            </div>
            <p className="font-mono text-[11px] text-neutral-500">
              {template.slug}
            </p>
            {template.description && (
              <p className="mt-2 max-w-2xl text-sm text-neutral-300">
                {template.description}
              </p>
            )}
          </div>
          <div className="text-[11px] text-neutral-500">
            Updated {new Date(template.updated_at).toLocaleString()}
          </div>
        </div>
      </header>

      <TargetTemplateDetailClient
        template={template}
        attached={attached ?? []}
        unattached={unattached ?? []}
      />
    </div>
  );
}
