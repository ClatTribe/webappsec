'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Finding, ScanEvent, ScanStatus } from '@/lib/supabase/types';

interface Props {
  scanId: string;
  initialStatus: ScanStatus;
}

export default function ScanLiveView({ scanId, initialStatus }: Props) {
  const supabase = createClient();
  const [status, setStatus] = useState<ScanStatus>(initialStatus);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: ev }, { data: fd }] = await Promise.all([
        supabase
          .from('scan_events')
          .select('*')
          .eq('scan_id', scanId)
          .order('id', { ascending: true })
          .limit(500),
        supabase
          .from('findings')
          .select('*')
          .eq('scan_id', scanId)
          .order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;
      setEvents((ev ?? []) as ScanEvent[]);
      setFindings((fd ?? []) as Finding[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId, supabase]);

  // Realtime subscriptions
  useEffect(() => {
    const channel = supabase
      .channel(`scan:${scanId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'scan_events',
          filter: `scan_id=eq.${scanId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as ScanEvent]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'findings',
          filter: `scan_id=eq.${scanId}`,
        },
        (payload) => {
          setFindings((prev) => [...prev, payload.new as Finding]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'scans',
          filter: `id=eq.${scanId}`,
        },
        (payload) => {
          setStatus((payload.new as { status: ScanStatus }).status);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [scanId, supabase]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          Live events
          <StatusBadge status={status} />
        </h2>
        <div className="mt-3 max-h-[60vh] overflow-y-auto font-mono text-xs">
          {events.length === 0 ? (
            <div className="text-neutral-500">Waiting for events...</div>
          ) : (
            events.map((e) => (
              <div key={e.id} className="border-l-2 border-neutral-800 py-1 pl-3">
                <span className="text-neutral-500">{new Date(e.created_at).toLocaleTimeString()}</span>{' '}
                <span className="text-neutral-400">{e.event_type}</span>{' '}
                {e.payload && (
                  <pre className="mt-1 whitespace-pre-wrap text-neutral-300">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium">
          Findings ({findings.length})
        </h2>
        <div className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto">
          {findings.length === 0 ? (
            <div className="text-neutral-500 text-sm">No findings yet.</div>
          ) : (
            findings.map((f) => (
              <div
                key={f.id}
                className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{f.title}</div>
                  <SeverityBadge severity={f.severity} />
                </div>
                <div className="mt-1 text-xs text-neutral-400">
                  {f.target}
                  {f.endpoint ? ` ${f.endpoint}` : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ScanStatus }) {
  const colors: Record<ScanStatus, string> = {
    queued: 'bg-neutral-700',
    running: 'bg-blue-600',
    completed: 'bg-green-600',
    failed: 'bg-red-600',
    cancelled: 'bg-neutral-600',
  };
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  const colors: Record<Finding['severity'], string> = {
    critical: 'bg-red-700',
    high: 'bg-orange-600',
    medium: 'bg-yellow-600',
    low: 'bg-lime-700',
    info: 'bg-neutral-700',
  };
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${colors[severity]}`}>
      {severity}
    </span>
  );
}
