import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function ScansListPage() {
  const supabase = createClient();
  const { data: scans } = await supabase
    .from('scans')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Scans</h1>
        <Link
          href="/scans/new"
          className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-neutral-950"
        >
          New scan
        </Link>
      </header>

      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-xs uppercase text-neutral-400">
            <tr>
              <th className="px-4 py-2">Run</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Mode</th>
              <th className="px-4 py-2">Cost</th>
              <th className="px-4 py-2">Started</th>
            </tr>
          </thead>
          <tbody>
            {scans?.map((scan) => (
              <tr key={scan.id} className="border-t border-neutral-800">
                <td className="px-4 py-2">
                  <Link href={`/scans/${scan.id}`} className="text-white hover:underline">
                    {scan.run_name}
                  </Link>
                </td>
                <td className="px-4 py-2">{scan.status}</td>
                <td className="px-4 py-2">{scan.scan_mode}</td>
                <td className="px-4 py-2 text-neutral-400">${scan.total_cost?.toFixed(2) ?? '0.00'}</td>
                <td className="px-4 py-2 text-neutral-400">
                  {scan.started_at ? new Date(scan.started_at).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
