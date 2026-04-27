import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const supabase = createClient();

  const [{ data: recentScans }, { count: openFindings }, { data: integrations }] =
    await Promise.all([
      supabase.from('scans').select('*').order('created_at', { ascending: false }).limit(5),
      supabase
        .from('findings')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'open'),
      supabase.from('integrations').select('id, type, name').eq('status', 'active').limit(20),
    ]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-neutral-400">Recent scans, findings, and integrations.</p>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Card label="Recent scans" value={recentScans?.length ?? 0} href="/scans" />
        <Card label="Open findings" value={openFindings ?? 0} href="/findings" />
        <Card label="Active integrations" value={integrations?.length ?? 0} href="/integrations" />
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent scans</h2>
          <Link
            href="/scans/new"
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-neutral-950"
          >
            New scan
          </Link>
        </div>
        <div className="mt-4 overflow-hidden rounded-md border border-neutral-800">
          {recentScans?.length ? (
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-xs uppercase text-neutral-400">
                <tr>
                  <th className="px-4 py-2">Run</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">Started</th>
                </tr>
              </thead>
              <tbody>
                {recentScans.map((scan) => (
                  <tr key={scan.id} className="border-t border-neutral-800">
                    <td className="px-4 py-2">
                      <Link href={`/scans/${scan.id}`} className="text-white hover:underline">
                        {scan.run_name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{scan.status}</td>
                    <td className="px-4 py-2">{scan.scan_mode}</td>
                    <td className="px-4 py-2 text-neutral-400">
                      {scan.started_at
                        ? new Date(scan.started_at).toLocaleString()
                        : 'pending'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-6 text-sm text-neutral-400">
              No scans yet. <Link href="/scans/new" className="text-white underline">Run your first scan</Link>.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Card({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-neutral-800 bg-neutral-900/50 p-4 hover:border-neutral-700"
    >
      <div className="text-xs uppercase text-neutral-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </Link>
  );
}
