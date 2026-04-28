import Link from 'next/link';
import { ShieldAlert, ScanLine } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import FindingCard from '@/components/finding/finding-card';
import type { Finding } from '@/lib/supabase/types';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const COUNT_PILL: Record<string, string> = {
  critical: 'bg-red-600/15 text-red-200 ring-1 ring-red-500/40',
  high: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-400/40',
  medium: 'bg-yellow-500/15 text-yellow-200 ring-1 ring-yellow-400/40',
  low: 'bg-lime-500/15 text-lime-200 ring-1 ring-lime-400/40',
  info: 'bg-neutral-700/40 text-neutral-200 ring-1 ring-neutral-600/40',
};

export default async function FindingsPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from('findings')
    .select('*, scans!inner(run_name, status)')
    .order('created_at', { ascending: false })
    .limit(200);

  const findings = ((data as (Finding & { scans?: { run_name: string; status: string } | null })[]) ?? []).slice();
  findings.sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]);
    const sb = SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);
    return sa - sb;
  });

  const counts = SEVERITY_ORDER.map((s) => ({
    severity: s,
    count: findings.filter((f) => f.severity === s).length,
  }));

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Findings</h1>
            <p className="mt-1.5 text-sm text-neutral-400">
              Vulnerabilities found across your scans. Click a card to read what the issue is, why it
              matters, and how to fix it.
            </p>
          </div>
        </div>
        {findings.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {counts.map((c) => (
              <div
                key={c.severity}
                className={`rounded-xl px-4 py-3 ${
                  c.count > 0 ? COUNT_PILL[c.severity] : 'bg-neutral-900/30 ring-1 ring-neutral-800'
                }`}
              >
                <div className={`text-2xl font-semibold ${c.count > 0 ? '' : 'text-neutral-600'}`}>
                  {c.count}
                </div>
                <div className="text-[10px] font-medium uppercase tracking-wider opacity-80">
                  {c.severity}
                </div>
              </div>
            ))}
          </div>
        )}
      </header>

      <div className="space-y-3">
        {findings.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/20 px-8 py-16 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900 ring-1 ring-neutral-800">
              <ShieldAlert className="h-6 w-6 text-neutral-500" strokeWidth={1.75} />
            </div>
            <h3 className="mt-4 text-base font-medium text-neutral-200">No findings yet</h3>
            <p className="mt-1 text-sm text-neutral-500">Findings appear here as scans complete.</p>
            <Link
              href="/scans/new"
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-200"
            >
              <ScanLine className="h-4 w-4" />
              Start a scan
            </Link>
          </div>
        ) : (
          findings.map((f) => (
            <div key={f.id}>
              {f.scans?.run_name && (
                <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] text-neutral-500">
                  <ScanLine className="h-3 w-3" strokeWidth={2} />
                  Found in scan{' '}
                  <Link
                    href={`/scans/${f.scan_id}`}
                    className="font-medium text-neutral-300 transition-colors hover:text-cyan-300"
                  >
                    {f.scans.run_name}
                  </Link>
                </div>
              )}
              <FindingCard finding={f} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
