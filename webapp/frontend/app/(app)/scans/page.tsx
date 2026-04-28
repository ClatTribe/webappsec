import Link from 'next/link';
import { Plus } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import ScansTable from './scans-table';
import type { Scan } from '@/lib/supabase/types';

export default async function ScansListPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from('scans')
    .select('*, targets(id, name, type)')
    .order('created_at', { ascending: false })
    .limit(50);

  type ScanWithTarget = Scan & {
    targets?: { id: string; name: string; type: string } | null;
  };
  const scans = (data as ScanWithTarget[]) ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Scans</h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            Every scan run by your organization. Filter by target, click a row to drill in.
          </p>
        </div>
        <Link
          href="/scans/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md hover:shadow-white/15"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New scan
        </Link>
      </header>

      <ScansTable scans={scans} />
    </div>
  );
}
