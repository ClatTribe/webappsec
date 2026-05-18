import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, Users, Plus, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Settings · Teams',
};

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
}

// Per-team workspaces foundation — list page.
//
// Each team is a sub-grouping inside one org. Teams scope target
// visibility (when enforcement lands — see migration 086's
// user_can_view_target() helper) and are the natural home for owner
// + routing metadata. RLS enforcement on team-scoped reads is a
// follow-up; this PR ships the data model + management surface.

export default async function TeamsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: teams } = (await supabase
    .from('teams')
    .select('id, name, slug, description, created_at')
    .is('archived_at', null)
    .order('name')) as unknown as { data: TeamRow[] | null };

  // Per-team counts batched.
  const ids = (teams ?? []).map((t) => t.id);
  let memberCount: Record<string, number> = {};
  let targetCount: Record<string, number> = {};
  if (ids.length > 0) {
    const [{ data: members }, { data: tt }] = await Promise.all([
      supabase.from('team_members').select('team_id').in('team_id', ids),
      supabase.from('team_targets').select('team_id').in('team_id', ids),
    ]);
    for (const r of (members ?? []) as Array<{ team_id: string }>) {
      memberCount[r.team_id] = (memberCount[r.team_id] ?? 0) + 1;
    }
    for (const r of (tt ?? []) as Array<{ team_id: string }>) {
      targetCount[r.team_id] = (targetCount[r.team_id] ?? 0) + 1;
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Teams</span>
      </nav>

      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
            <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
          </div>
          <p className="max-w-2xl text-sm text-neutral-400">
            Sub-groupings inside your org. A team owns a set of targets and
            has a roster of users. When team-scoped read enforcement lands,
            a target with no team owner stays org-wide visible; a target
            with one or more team owners is visible only to those teams
            (plus org admins).
          </p>
        </div>
        <Link
          href="/settings/teams/new"
          className="inline-flex items-center gap-1.5 self-start rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-2 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New team
        </Link>
      </header>

      {(teams?.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-10 text-center">
          <Users className="mx-auto h-8 w-8 text-neutral-600" strokeWidth={1.5} />
          <h2 className="mt-4 text-base font-semibold text-white">No teams yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
            Once your org has more than ~5 people, splitting into teams (one
            per service area, security squad, etc.) makes finding-routing
            and target ownership obvious.
          </p>
          <Link
            href="/settings/teams/new"
            className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-950"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            Create your first team
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {teams!.map((t) => (
            <Link
              key={t.id}
              href={`/settings/teams/${t.slug}`}
              className="group flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-white">
                    {t.name}
                  </h3>
                  <p className="font-mono text-[10px] text-neutral-500">{t.slug}</p>
                </div>
              </div>
              {t.description && (
                <p className="mt-2 line-clamp-2 text-[12px] text-neutral-400">
                  {t.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3 text-[11px] text-neutral-500">
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3 w-3" strokeWidth={2.25} />
                  {memberCount[t.id] ?? 0} member
                  {(memberCount[t.id] ?? 0) === 1 ? '' : 's'}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
                  {targetCount[t.id] ?? 0} target
                  {(targetCount[t.id] ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
