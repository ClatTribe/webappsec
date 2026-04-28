'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ScanLine, EyeOff, Eye } from 'lucide-react';
import FindingCard from './finding-card';
import type { Finding } from '@/lib/supabase/types';

type FindingWithScan = Finding & { scans?: { run_name: string; status: string } | null };

const RESOLVED_STATUSES = new Set(['fixed', 'false_positive', 'wont_fix']);

export default function FindingsFilter({ findings }: { findings: FindingWithScan[] }) {
  const [showResolved, setShowResolved] = useState(false);

  const open = findings.filter((f) => !RESOLVED_STATUSES.has(f.status));
  const resolved = findings.filter((f) => RESOLVED_STATUSES.has(f.status));
  const visible = showResolved ? findings : open;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-400">
          {showResolved
            ? `${findings.length} total · ${open.length} open + ${resolved.length} resolved`
            : `${open.length} open · ${resolved.length} resolved hidden`}
        </div>
        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/40 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
        >
          {showResolved ? (
            <>
              <EyeOff className="h-3.5 w-3.5" />
              Hide resolved
            </>
          ) : (
            <>
              <Eye className="h-3.5 w-3.5" />
              Show resolved ({resolved.length})
            </>
          )}
        </button>
      </div>

      <div className="space-y-3">
        {visible.map((f) => (
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
        ))}
      </div>
    </div>
  );
}
