import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export default async function FindingsPage() {
  const supabase = createClient();
  const { data: findings } = await supabase
    .from('findings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Findings</h1>
        <p className="text-sm text-neutral-400">
          Validated vulnerabilities across all your scans, ordered by severity.
        </p>
      </header>

      <div className="space-y-2">
        {(findings ?? [])
          .slice()
          .sort(
            (a, b) =>
              SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
              SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]),
          )
          .map((f) => (
            <div
              key={f.id}
              className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <Link
                    href={`/scans/${f.scan_id}`}
                    className="font-medium text-white hover:underline"
                  >
                    {f.title}
                  </Link>
                  <div className="text-xs text-neutral-500">
                    {f.target} {f.endpoint ?? ''} · {f.status}
                  </div>
                </div>
                <span className="rounded-md bg-neutral-700 px-2 py-0.5 text-xs uppercase">
                  {f.severity}
                </span>
              </div>
            </div>
          ))}

        {(!findings || findings.length === 0) && (
          <div className="rounded-md border border-neutral-800 p-4 text-sm text-neutral-500">
            No findings yet — they appear here as scans complete.
          </div>
        )}
      </div>
    </div>
  );
}
