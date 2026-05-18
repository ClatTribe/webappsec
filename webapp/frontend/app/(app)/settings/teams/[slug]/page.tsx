import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ChevronRight, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import TeamDetailClient from './team-detail-client';

export const metadata = {
  title: 'Settings · Team',
};

interface Team {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  user_id: string;
  role: 'member' | 'lead';
  added_at: string;
}

interface AttachedTarget {
  id: string;
  name: string;
  type: string;
  value: string;
}

export default async function TeamDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: team } = (await supabase
    .from('teams')
    .select('id, name, slug, description, created_at, updated_at')
    .eq('slug', params.slug)
    .is('archived_at', null)
    .maybeSingle()) as unknown as { data: Team | null };

  if (!team) notFound();

  const [{ data: members }, { data: targetLinks }] = await Promise.all([
    supabase
      .from('team_members')
      .select('user_id, role, added_at')
      .eq('team_id', team.id),
    supabase
      .from('team_targets')
      .select('target_id')
      .eq('team_id', team.id),
  ]);

  const targetIds = ((targetLinks ?? []) as Array<{ target_id: string }>).map(
    (r) => r.target_id,
  );
  let attached: AttachedTarget[] = [];
  if (targetIds.length > 0) {
    const { data: ts } = (await supabase
      .from('targets')
      .select('id, name, type, value')
      .in('id', targetIds)) as unknown as { data: AttachedTarget[] | null };
    attached = ts ?? [];
  }

  // Targets eligible to attach — every active target not yet attached
  // to this team. Capped at 200 like the project detail page.
  const { data: allTargets } = (await supabase
    .from('targets')
    .select('id, name, type, value')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(500)) as unknown as { data: AttachedTarget[] | null };
  const attachedIds = new Set(attached.map((t) => t.id));
  const unattached = (allTargets ?? []).filter((t) => !attachedIds.has(t.id));

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link
          href="/settings/teams"
          className="transition-colors hover:text-neutral-300"
        >
          Teams
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">{team.name}</span>
      </nav>

      <header className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5">
        <div className="flex items-start gap-2">
          <Users className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {team.name}
            </h1>
            <p className="font-mono text-[11px] text-neutral-500">{team.slug}</p>
            {team.description && (
              <p className="mt-2 max-w-2xl text-sm text-neutral-300">
                {team.description}
              </p>
            )}
          </div>
        </div>
      </header>

      <TeamDetailClient
        team={team}
        members={(members ?? []) as MemberRow[]}
        attachedTargets={attached}
        unattachedTargets={unattached}
      />
    </div>
  );
}
