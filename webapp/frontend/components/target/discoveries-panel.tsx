'use client';

import { useEffect, useState, useTransition } from 'react';
import { Globe, Plus, X, Loader2, ShieldQuestion, Check, Search } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { TargetType } from '@/lib/supabase/types';

// One row from public.target_discoveries.
interface Discovery {
  id: string;
  target_id: string;
  org_id: string;
  source: 'crt_sh' | 'subfinder' | 'manual';
  value: string;
  first_seen_at: string;
  last_seen_at: string;
  status: 'pending' | 'accepted' | 'dismissed';
  promoted_target_id: string | null;
}

interface Props {
  targetId: string;
  targetType: TargetType;
  /** Whether the user has opted in to subdomain discovery for this target. */
  autoDiscover: boolean;
}

// Subdomain auto-discovery (roadmap §9). When the user added a `domain`
// target, the worker hit crt.sh and wrote rows here. Show the pending ones,
// let the user accept (→ becomes a real target) or dismiss them.
//
// We don't render anything for non-domain targets, or when no discoveries
// exist — keeping the page calm on first visit.
export default function DiscoveriesPanel({ targetId, targetType, autoDiscover }: Props) {
  const supabase = createClient();
  const [discoveries, setDiscoveries] = useState<Discovery[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(autoDiscover);
  const [, startTransition] = useTransition();

  // Initial load + realtime subscription so freshly-found subdomains
  // appear without a refresh.
  useEffect(() => {
    if (targetType !== 'domain') return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('target_discoveries')
        .select('*')
        .eq('target_id', targetId)
        .order('value', { ascending: true });
      if (!cancelled) setDiscoveries((data as Discovery[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, targetId, targetType]);

  useEffect(() => {
    if (targetType !== 'domain') return;
    const channel = supabase
      .channel(`target_discoveries:${targetId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'target_discoveries',
          filter: `target_id=eq.${targetId}`,
        },
        (payload) =>
          setDiscoveries((prev) =>
            prev ? [...prev, payload.new as Discovery] : [payload.new as Discovery],
          ),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'target_discoveries',
          filter: `target_id=eq.${targetId}`,
        },
        (payload) => {
          const next = payload.new as Discovery;
          setDiscoveries((prev) => prev?.map((d) => (d.id === next.id ? next : d)) ?? null);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, targetId, targetType]);

  // Flip targets.auto_discover = true via direct UPDATE under RLS. The
  // SQL trigger then fires `target_discovery_requested` for the worker,
  // which kicks off the crt.sh enumeration. We don't need an explicit
  // notify here — the migration's UPDATE trigger handles it.
  const onEnableAutoDiscover = () => {
    setEnabling(true);
    setError(null);
    startTransition(async () => {
      const { error: updErr } = await supabase
        .from('targets')
        .update({ auto_discover: true })
        .eq('id', targetId);
      if (updErr) {
        setError(updErr.message);
        setEnabling(false);
        return;
      }
      setEnabled(true);
      setEnabling(false);
    });
  };

  if (targetType !== 'domain') return null;

  const pending = (discoveries ?? []).filter((d) => d.status === 'pending');
  const accepted = (discoveries ?? []).filter((d) => d.status === 'accepted');

  // Don't render until the initial query lands.
  if (discoveries === null) return null;

  // No discoveries AND user hasn't opted in: show a CTA so they can flip the
  // flag from this page (instead of having to recreate the target).
  if (!enabled && pending.length === 0 && accepted.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div className="flex items-start gap-3">
          <Search className="mt-0.5 h-4 w-4 flex-shrink-0 text-neutral-500" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold text-neutral-200">
              Find subdomains automatically?
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
              We can look up this domain in public Certificate Transparency logs and suggest each
              subdomain as a separate target. Off by default — turn it on if you want broader
              coverage. Free, no scans run automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={onEnableAutoDiscover}
            disabled={enabling}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[12px] font-medium text-cyan-200 transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {enabling ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
            ) : (
              <Search className="h-3 w-3" strokeWidth={2.5} />
            )}
            {enabling ? 'Searching…' : 'Find subdomains'}
          </button>
        </div>
        {error && (
          <p className="mt-3 text-[11.5px] text-red-300">{error}</p>
        )}
      </section>
    );
  }

  // Otherwise (enabled, OR has historical data): render the panel as usual.
  if (pending.length === 0 && accepted.length === 0) {
    // Enabled but the worker hasn't written anything yet → quiet wait.
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div className="flex items-center gap-2 text-[12px] text-neutral-400">
          <Loader2 className="h-3 w-3 animate-spin text-cyan-300/80" strokeWidth={2.5} />
          Searching public CT logs for subdomains…
        </div>
      </section>
    );
  }

  const onAccept = (d: Discovery) => {
    setBusy(d.id);
    setError(null);
    startTransition(async () => {
      const { error: rpcErr } = await supabase.rpc('promote_discovery_to_target', {
        p_discovery_id: d.id,
      });
      if (rpcErr) {
        setError(rpcErr.message);
      }
      setBusy(null);
    });
  };

  const onDismiss = (d: Discovery) => {
    setBusy(d.id);
    setError(null);
    startTransition(async () => {
      const { error: updErr } = await supabase
        .from('target_discoveries')
        .update({ status: 'dismissed' })
        .eq('id', d.id);
      if (updErr) {
        setError(updErr.message);
      }
      setBusy(null);
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          Subdomains we found
        </h2>
        <span className="text-xs text-neutral-500">
          via Certificate Transparency · {pending.length} pending
        </span>
      </div>

      <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div className="flex items-start gap-3">
          <ShieldQuestion
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-cyan-300/80"
            strokeWidth={2}
          />
          <p className="text-sm leading-relaxed text-neutral-300">
            We searched public Certificate Transparency logs for any subdomain ever issued a TLS
            certificate under this domain. <strong>Accept</strong> to add a subdomain as its own
            target (it won't be scanned automatically — you'll need to start a scan from its target
            page). <strong>Dismiss</strong> hides it from this list permanently.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-800/80 bg-neutral-900/30 px-3 py-2"
            >
              <Globe className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400/70" strokeWidth={2} />
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-neutral-200">
                {d.value}
              </code>
              <button
                type="button"
                onClick={() => onAccept(d)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-200 transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="Add as a target"
              >
                {busy === d.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                ) : (
                  <Plus className="h-3 w-3" strokeWidth={2.5} />
                )}
                Accept
              </button>
              <button
                type="button"
                onClick={() => onDismiss(d)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Hide from this list"
              >
                <X className="h-3 w-3" strokeWidth={2.5} />
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}

      {accepted.length > 0 && (
        <details className="rounded-lg border border-neutral-800/60 bg-neutral-900/20 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-neutral-400 hover:text-neutral-200">
            <Check className="mr-1 inline h-3 w-3 text-emerald-400" strokeWidth={2.5} />
            {accepted.length} already added as target{accepted.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1 text-[12px]">
            {accepted.map((d) => (
              <li key={d.id} className="font-mono text-neutral-400">
                {d.value}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
