import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { BrandLockup } from '@/components/marketing/marketing-shell';
import OnboardingDialog from '@/components/onboarding/onboarding-dialog';
import {
  LayoutDashboard,
  MessageSquare,
  Target,
  ScanLine,
  ShieldAlert,
  Plug,
  Users,
  Settings,
  LogOut,
  FileLock,
  FolderKanban,
} from 'lucide-react';

const NAV = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // Projects (Phase C) sit above Targets in the IA — they're the
  // natural grouping mid-market teams reach for first; targets are
  // the leaf nodes within them.
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/targets', label: 'Targets', icon: Target },
  { href: '/scans', label: 'Scans', icon: ScanLine },
  { href: '/findings', label: 'Findings', icon: ShieldAlert },
  { href: '/compliance', label: 'Compliance', icon: FileLock },
  { href: '/integrations', label: 'Integrations', icon: Plug },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  const { data: orgs } = await supabase.from('organizations').select('*').limit(5);
  const org = orgs?.[0];

  // Tier II #9 — onboarding wizard.
  // Only fetch the integration list when the wizard is actually going
  // to show. Saves a round-trip on every page load for the 99% of
  // users who are past onboarding. The migration 067 backfill marks
  // existing users as 'completed' so this is mostly a new-signup path.
  const onboardingState =
    (profile as { onboarding_state?: string } | null)?.onboarding_state ?? 'completed';
  const showOnboarding =
    onboardingState === 'pending' || onboardingState === 'in_progress';

  let onboardingIntegrations: Array<{
    id: string;
    type: string;
    status: string;
    name: string;
    metadata?: { login?: string };
  }> = [];
  if (showOnboarding) {
    const { data } = await supabase
      .from('integrations')
      .select('id, type, status, name, metadata')
      .eq('type', 'github')
      .eq('status', 'active');
    onboardingIntegrations = (data ?? []) as typeof onboardingIntegrations;
  }
  const initials = (profile?.full_name ?? user.email ?? '?')
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s: string) => s[0]?.toUpperCase())
    .join('');

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-neutral-800/80 bg-neutral-950/40 backdrop-blur-xl">
        <Link
          href="/dashboard"
          className="px-5 pb-3 pt-6"
        >
          <BrandLockup />
        </Link>

        {org && (
          <div className="mx-3 mt-3 rounded-lg border border-neutral-800/80 bg-neutral-900/40 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">Organization</div>
            <div className="mt-0.5 truncate text-sm font-medium text-neutral-100">{org.name}</div>
            {org.plan && (
              <div className="mt-1 inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-300/80 ring-1 ring-cyan-500/20">
                {org.plan}
              </div>
            )}
          </div>
        )}

        <nav className="mt-6 flex flex-col gap-0.5 px-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-50"
              >
                <Icon className="h-4 w-4 transition-colors group-hover:text-cyan-300" strokeWidth={2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto px-3 pb-5">
          <div className="rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs font-semibold text-white shadow-md shadow-violet-500/20">
                {initials || 'U'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-100">
                  {profile?.full_name ?? user.email}
                </div>
                <div className="truncate text-[11px] text-neutral-500">{user.email}</div>
              </div>
            </div>
            <form action="/api/auth/signout" method="post" className="mt-2.5">
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-neutral-800/80 px-2 py-1.5 text-xs text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="flex-1 px-10 py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Tier II #9 — onboarding wizard. Rendered only when the
          server-side profile state is pending/in_progress so we never
          flash the modal to users who've completed it or dismissed
          it on a prior visit. The component fetches integration data
          via the prop list passed here. */}
      {showOnboarding && <OnboardingDialog initialIntegrations={onboardingIntegrations} />}
    </div>
  );
}
