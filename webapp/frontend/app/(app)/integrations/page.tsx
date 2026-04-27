import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import type { IntegrationType } from '@/lib/supabase/types';

const INTEGRATION_TYPES: { type: IntegrationType; label: string; href: string }[] = [
  { type: 'github', label: 'GitHub', href: '/integrations/new/github' },
  { type: 'gitlab', label: 'GitLab', href: '/integrations/new/gitlab' },
  { type: 'aws', label: 'AWS (IAM Role)', href: '/integrations/new/aws' },
  { type: 'azure', label: 'Azure (Service Principal)', href: '/integrations/new/azure' },
  { type: 'gcp', label: 'GCP (Service Account)', href: '/integrations/new/gcp' },
  { type: 'k8s', label: 'Kubernetes (Kubeconfig)', href: '/integrations/new/k8s' },
  { type: 'webhook', label: 'Webhook', href: '/integrations/new/webhook' },
];

export default async function IntegrationsPage() {
  const supabase = createClient();
  const { data: integrations } = await supabase
    .from('integrations')
    .select('*')
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-neutral-400">
          Credentials Strix can use during scans. Decrypted only at scan time and never sent to the LLM.
        </p>
      </header>

      <section>
        <h2 className="text-sm font-medium uppercase text-neutral-400">Connected</h2>
        <div className="mt-3 space-y-2">
          {integrations?.length ? (
            integrations.map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/50 p-3"
              >
                <div>
                  <div className="font-medium">
                    [{i.type}] {i.name}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {i.last_used_at
                      ? `Last used ${new Date(i.last_used_at).toLocaleString()}`
                      : 'Never used'}
                  </div>
                </div>
                <span className="text-xs uppercase text-neutral-400">{i.status}</span>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-neutral-800 p-4 text-sm text-neutral-500">
              No integrations connected yet.
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase text-neutral-400">Connect new</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {INTEGRATION_TYPES.map((it) => (
            <Link
              key={it.type}
              href={it.href}
              className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 hover:border-neutral-700"
            >
              <div className="font-medium">{it.label}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
