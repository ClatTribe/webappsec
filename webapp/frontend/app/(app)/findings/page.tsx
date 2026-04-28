import Link from 'next/link';
import { ShieldAlert, ScanLine } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import FindingCard from '@/components/finding/finding-card';
import FindingsFilter from '@/components/finding/findings-filter';
import type { Finding } from '@/lib/supabase/types';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const STATUS_RANK: Record<string, number> = {
  open: 0,
  triaged_real: 1,
  fixed: 2,
  wont_fix: 3,
  false_positive: 4,
};

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

  // Sort: by triage state (open first, resolved last), then by severity within each.
  findings.sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 99;
    const sb = STATUS_RANK[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    const va = SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]);
    const vb = SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);
    return va - vb;
  });

  // Severity counts only count *open* findings — resolved ones shouldn't drive
  // the "I have N criticals" gut-check at the top.
  const openFindings = findings.filter((f) => f.status === 'open');
  const counts = SEVERITY_ORDER.map((s) => ({
    severity: s,
    count: openFindings.filter((f) => f.severity === s).length,
  }));

  const resolvedCount = findings.filter((f) =>
    ['fixed', 'false_positive', 'wont_fix'].includes(f.status),
  ).length;

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Findings</h1>
            <p className="mt-1.5 text-sm text-neutral-400">
              Vulnerabilities found across your scans. Click a card to read what the issue is, why it
              matters, and how to fix it. Use the triage buttons inside each finding to mark it
              fixed, a false positive, or won&apos;t-fix.
            </p>
          </div>
        </div>

        {findings.length > 0 && (
          <>
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
                    open · {c.severity}
                  </div>
                </div>
              ))}
            </div>
            {resolvedCount > 0 && (
              <div className="text-xs text-neutral-500">
                {resolvedCount} resolved finding{resolvedCount === 1 ? '' : 's'} (fixed / wont-fix /
                false positive) — toggle below to see them.
              </div>
            )}
          </>
        )}
      </header>

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
        <FindingsFilter findings={findings} />
      )}
    </div>
  );
}
