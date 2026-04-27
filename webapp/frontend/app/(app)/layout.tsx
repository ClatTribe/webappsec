import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/scans', label: 'Scans' },
  { href: '/findings', label: 'Findings' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/team', label: 'Team' },
  { href: '/settings', label: 'Settings' },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Pull profile + org for the header.
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  const { data: orgs } = await supabase.from('organizations').select('*').limit(5);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-neutral-800 px-4 py-6">
        <Link href="/dashboard" className="mb-8 text-xl font-semibold">
          Strix
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-white"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto pt-6 text-xs text-neutral-500">
          <div>{profile?.full_name ?? user.email}</div>
          <div className="mt-1 text-neutral-600">{orgs?.[0]?.name}</div>
          <form action="/api/auth/signout" method="post" className="mt-3">
            <button type="submit" className="text-neutral-400 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
