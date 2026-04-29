import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';

interface Props {
  params: { id: string };
}

export default async function IntegrationDetailPage({ params }: Props) {
  const supabase = createClient();
  const { data: integration } = await supabase
    .from('integrations')
    .select('*')
    .eq('id', params.id)
    .single();
  if (!integration) notFound();

  const { data: usedIn } = await supabase
    .from('scan_integrations')
    .select('scan_id, scans(run_name, status, created_at)')
    .eq('integration_id', params.id)
    .limit(20);

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{integration.name}</h1>
        <div className="text-sm text-neutral-400">
          [{integration.type}] · {integration.status}
        </div>
      </header>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium uppercase text-neutral-400">Metadata</h2>
        <pre className="mt-3 overflow-auto rounded-md bg-neutral-950 p-3 text-xs text-neutral-300">
          {JSON.stringify(integration.metadata, null, 2)}
        </pre>
      </section>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium uppercase text-neutral-400">Recent uses</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(usedIn ?? []).map((u, i) => {
            // Supabase typegen returns embedded relations as arrays even when
            // the FK guarantees at most one row. Normalise both shapes so
            // `next build` doesn't fail on the type cast.
            const raw = (u as { scans: unknown }).scans;
            const s = (Array.isArray(raw) ? raw[0] : raw) as
              | { run_name: string; status: string; created_at: string }
              | undefined;
            if (!s) return null;
            return (
              <li key={i} className="flex items-center justify-between">
                <span>{s.run_name}</span>
                <span className="text-neutral-400">{s.status}</span>
              </li>
            );
          })}
          {(!usedIn || usedIn.length === 0) && (
            <li className="text-neutral-500">Not yet used in any scan.</li>
          )}
        </ul>
      </section>

      <form action={`/api/integrations/${params.id}`} method="post">
        <input type="hidden" name="_method" value="DELETE" />
        <button
          formMethod="delete"
          formAction={`/api/integrations/${params.id}`}
          className="rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-900/20"
        >
          Revoke integration
        </button>
      </form>
    </div>
  );
}
