import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { BrandLockup } from '@/components/marketing/marketing-shell';
import OnboardingDialog from '@/components/onboarding/onboarding-dialog';
import {
  Home,
  MessageSquare,
  ShieldAlert,
  LogOut,
  FileLock,
  FolderKanban,
  Boxes,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Nav revamp (PR A). Maps the four jobs a non-security developer
// actually has: see status, see what to monitor, see what's broken,
// see audit posture. Configuration goes behind one "Setup" section.
//
// Conditional items:
//   - Projects appears once targets.count >= 5 (mid-market signal).
//     The threshold is hard-coded here rather than a settings flag so
//     the surface shows up automatically when it's useful.
//
// Removed from primary nav (still reachable by URL):
//   - /dashboard  — replaced by adaptive Home (PR B)
//   - /exec       — surfaced as "Share with the board" CTA, not a tab
//   - /scans      — surfaced inside Asset detail and as context on
//                   individual findings; almost nobody opens "scans"
//                   as a first move
//   - /integrations, /team, /settings — moved behind /setup

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const PRIMARY_NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/assets', label: 'Assets', icon: Boxes },
  { href: '/findings', label: 'Findings', icon: ShieldAlert },
  { href: '/compliance', label: 'Compliance', icon: FileLock },
];

const SECONDARY_NAV: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/setup', label: 'Setup', icon: Wrench },
];

// Threshold at which the Projects nav item starts appearing. Picked
// because that's the point at which a flat target list stops fitting
// on one screen and grouping starts paying for itself.
const PROJECTS_NAV_THRESHOLD = 5;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  const { data: orgs } = await supabase.from('organizations').select('*').limit(5);
  const org = orgs?.[0];

  // Conditional Projects nav — only show once the user has enough
  // targets to benefit from grouping. Counts active targets only;
  // dormant/archived don't trigger the threshold.
  const { count: activeTargetCount } = await supabase
    .from('targets')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  const showProjectsNav = (activeTargetCount ?? 0) >= PROJECTS_NAV_THRESHOLD;

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
        <Link href="/home" className="px-5 pb-3 pt-6">
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

        <nav className="mt-6 flex flex-1 flex-col gap-0.5 px-3">
          {/* Primary — the four jobs */}
          {PRIMARY_NAV.map((item) => (
            <NavLinkRow key={item.href} {...item} />
          ))}

          {/* Conditional: Projects appears once an org has >= N
              active targets. The empty rendering keeps the nav stable
              for fresh accounts. */}
          {showProjectsNav && (
            <NavLinkRow href="/projects" label="Projects" icon={FolderKanban} />
          )}

          {/* Secondary — chat is universal (people know how to use it)
              and Setup collapses all configuration entry points. Pushed
              to the bottom of the rail via mt-auto so primary nav
              sits at eye level. */}
          <div className="mt-auto pt-4">
            <div className="mb-1 px-3 text-[10px] uppercase tracking-wider text-neutral-600">
              Tools
            </div>
            {SECONDARY_NAV.map((item) => (
              <NavLinkRow key={item.href} {...item} />
            ))}
          </div>
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

function NavLinkRow({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-50"
    >
      <Icon
        className="h-4 w-4 transition-colors group-hover:text-cyan-300"
        strokeWidth={2}
      />
      <span>{label}</span>
    </Link>
  );
}
