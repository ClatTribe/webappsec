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
  // Phase A — apex-domain "integration" powers subdomain discovery via crt.sh.
  { type: 'domain', label: 'Apex domain (subdomain discovery)', href: '/integrations/new/domain' },
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
          Credentials TensorShield can use during scans. Decrypted only at scan time and never sent to the LLM.
        </p>
      </header>

      {/* Tier II #8 — MCP / API key surface. Pinned at the top of the
          integrations page because it's the most-used "connection"
          for vibe-coders: paste a Bearer into Cursor / Claude Code. */}
      <Link
        href="/settings/api-keys"
        className="flex items-center justify-between rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] px-4 py-3.5 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/[0.06]"
      >
        <div>
          <div className="text-sm font-medium text-cyan-100">
            Connect Cursor / Claude Code via MCP
          </div>
          <div className="mt-0.5 text-[11.5px] text-cyan-200/70">
            Mint an API key so your AI assistant can ask TensorShield about your security posture.
          </div>
        </div>
        <span className="rounded-md bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-400/30">
          New
        </span>
      </Link>

      <section>
        <h2 className="text-sm font-medium uppercase text-neutral-400">Connected</h2>
        <div className="mt-3 space-y-2">
          {integrations?.length ? (
            integrations.map((i) => {
              const meta = (i.metadata ?? {}) as Record<string, unknown>;
              const prEnabled = !!meta.webhook_secret && !!meta.repo_full_name;
              return (
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
                  <div className="flex items-center gap-2">
                    {/* Phase A — asset discovery link. Surfaced for
                        every integration type that has a discoverer
                        wired. Keep this list in sync with
                        lib/asset-discoverers/registry.ts. */}
                    {(i.type === 'github' || i.type === 'aws' || i.type === 'domain') && (
                      <Link
                        href={`/integrations/${i.id}/discovered`}
                        className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/20"
                      >
                        Discover assets
                      </Link>
                    )}
                    {/* Tier II #7 — quick link to enable PR scanning per
                        github integration. Pill colour reflects current
                        state so the user can see at a glance which
                        integrations are wired up. */}
                    {i.type === 'github' && (
                      <Link
                        href={`/integrations/${i.id}/pr-scanning`}
                        className={`rounded-md border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${
                          prEnabled
                            ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                            : 'border-neutral-700 bg-neutral-800/50 text-neutral-300 hover:border-cyan-500/40 hover:text-cyan-200'
                        }`}
                      >
                        {prEnabled ? 'PR scan · on' : 'Enable PR scan'}
                      </Link>
                    )}
                    <span className="text-xs uppercase text-neutral-400">{i.status}</span>
                  </div>
                </div>
              );
            })
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
