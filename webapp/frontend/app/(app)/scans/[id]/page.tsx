import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import ScanLiveView from '@/components/scan/scan-live-view';

interface Props {
  params: { id: string };
}

export default async function ScanDetailPage({ params }: Props) {
  const supabase = createClient();
  const { data: scan } = await supabase.from('scans').select('*').eq('id', params.id).single();
  if (!scan) notFound();

  const { data: targets } = await supabase
    .from('scan_targets')
    .select('*')
    .eq('scan_id', params.id);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{scan.run_name}</h1>
        <div className="mt-1 text-sm text-neutral-400">
          {scan.status} · {scan.scan_mode} · {scan.llm_provider ?? '—'}
        </div>
      </header>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium">Targets</h2>
        <ul className="mt-2 space-y-1 text-sm text-neutral-300">
          {targets?.map((t) => (
            <li key={t.id}>
              <span className="text-neutral-500">[{t.type}]</span> {t.value}
            </li>
          ))}
        </ul>
      </section>

      {/* Live view subscribes to scan_events + findings via Realtime */}
      <ScanLiveView scanId={params.id} initialStatus={scan.status} />
    </div>
  );
}
