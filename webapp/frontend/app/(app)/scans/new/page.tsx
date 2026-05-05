'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Plus, Target as TargetIcon, Network } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Integration, ScanMode, Target } from '@/lib/supabase/types';

// CIDR host-count preview helper (engine PR #124 / wishlist §13.3 row 2).
// We render the preview inline on every ip_address target so the operator
// sees "/24 = 256 hosts" before launching a scan that could fan out to
// hundreds of probes. Pure JS — no engine round-trip, no API call.
//
// Returns null when the value isn't a recognised CIDR. We accept both
// IPv4 (/0–/32) and IPv6 (/0–/128); IPv6 host counts are truncated to a
// scientific-notation string so a /48 doesn't render 2^80 digits.
function previewCidrHosts(value: string): string | null {
  const v = value.trim();
  const slash = v.indexOf('/');
  if (slash <= 0) return null;
  const prefix = Number.parseInt(v.slice(slash + 1), 10);
  if (!Number.isFinite(prefix)) return null;
  // IPv4 detection — at least one dot in the address part, prefix 0–32.
  const isIpv4 = /\./.test(v.slice(0, slash)) && prefix >= 0 && prefix <= 32;
  // IPv6 detection — at least one colon in the address part, prefix 0–128.
  const isIpv6 = /:/.test(v.slice(0, slash)) && prefix >= 0 && prefix <= 128;
  if (!isIpv4 && !isIpv6) return null;
  const bits = isIpv4 ? 32 - prefix : 128 - prefix;
  if (bits === 0) return '1 host';
  if (bits <= 32) {
    const hosts = 2 ** bits;
    return `${hosts.toLocaleString()} host${hosts === 1 ? '' : 's'}`;
  }
  // Beyond a billion hosts the operator shouldn't be reading exact
  // counts anyway — a magnitude warning is more honest than a giant
  // localised number. e.g. /48 IPv6 = 2^80 ≈ 1.2e+24.
  const hosts = 2 ** bits;
  return `~${hosts.toExponential(1)} hosts`;
}

function NewScanInner() {
  const router = useRouter();
  const params = useSearchParams();
  const supabase = createClient();

  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<string | null>(params.get('target'));
  const [scanMode, setScanMode] = useState<ScanMode>('standard');
  const [instruction, setInstruction] = useState('');
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [dnsOnly, setDnsOnly] = useState(false);
  const [branch, setBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('targets')
      .select('*')
      .eq('status', 'active')
      .order('last_scan_at', { ascending: false, nullsFirst: false })
      .then(({ data }) => {
        const list = (data ?? []) as Target[];
        setTargets(list);
        if (!targetId && list.length === 1) setTargetId(list[0].id);
      });
    supabase
      .from('integrations')
      .select('*')
      .eq('status', 'active')
      .then(({ data }) => setIntegrations((data ?? []) as Integration[]));
  }, [supabase, targetId]);

  const selected = targets.find((t) => t.id === targetId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError('Pick a target.');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_id: selected.id,
        targets: [selected.value],
        scan_mode: scanMode,
        instruction_text: instruction.trim() || null,
        integration_ids: integrationIds,
        // Engine PR #30 — passive recon mode (only valid for domain targets).
        // Forwarded to the worker as STRIX_DNS_ONLY=1 / --dns-only flag.
        dns_only: dnsOnly && selected.type === 'domain',
        // Engine PR #117 — branch picker (only valid for repository
        // targets). Forwarded as `--branch <ref>`. Send only when the
        // user actually typed something — null lets the engine fall
        // back to the repo's default branch.
        branch:
          selected.type === 'repository' && branch.trim().length > 0
            ? branch.trim()
            : undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to queue scan');
      setSubmitting(false);
      return;
    }
    const { scan_id } = await res.json();
    router.push(`/scans/${scan_id}`);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/scans" className="transition-colors hover:text-neutral-300">
          Scans
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">New scan</span>
      </nav>

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">New scan</h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            Pick a target to scan. Findings will roll up to that target across runs.
          </p>
        </div>
        {/* CI snippet generator (engine PR #121 / wishlist §13.3 row 3).
            Power users running strix in their own pipeline grab the
            YAML from here — those scans bypass the wrapper. */}
        <Link
          href="/scans/ci-snippet"
          className="hidden flex-shrink-0 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800/40 sm:inline-block"
          title="Generate a GitHub Actions / GitLab CI snippet for running strix in your pipeline"
        >
          CI / CD snippet →
        </Link>
      </header>

      <form onSubmit={onSubmit} className="space-y-6">
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Target
            </span>
            <Link
              href="/targets/new"
              className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:underline"
            >
              <Plus className="h-3 w-3" /> Add new
            </Link>
          </div>
          {targets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 px-6 py-10 text-center">
              <TargetIcon className="mx-auto h-6 w-6 text-neutral-500" strokeWidth={1.75} />
              <p className="mt-3 text-sm text-neutral-300">No targets yet</p>
              <p className="mt-1 text-xs text-neutral-500">
                Add a repo, app, or domain first.
              </p>
              <Link
                href="/targets/new"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-neutral-200"
              >
                <Plus className="h-3.5 w-3.5" /> Add target
              </Link>
            </div>
          ) : (
            <div className="space-y-1.5">
              {targets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTargetId(t.id)}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                    targetId === t.id
                      ? 'border-cyan-500/50 bg-cyan-500/10'
                      : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-neutral-100">{t.name}</span>
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-neutral-400">
                        {t.type}
                      </span>
                      {/* CIDR host-count preview (engine PR #124 / wishlist
                          §13.3). Only shown for ip_address targets whose
                          value parses as a CIDR — gives the operator a
                          "before-you-launch" sanity check against runaway
                          fan-out. */}
                      {t.type === 'ip_address' && (() => {
                        const preview = previewCidrHosts(t.value);
                        if (!preview) return null;
                        return (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-400/30"
                            title="Expected probe fan-out for this CIDR. Each host gets a port scan + service probe."
                          >
                            <Network className="h-2.5 w-2.5" strokeWidth={2.5} />
                            {preview}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-400">
                      {t.value}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            Scan mode
          </div>
          <div className="flex gap-2">
            {(['quick', 'standard', 'deep'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setScanMode(m)}
                className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  scanMode === m
                    ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                    : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </section>

        {/* Branch picker (engine PR #117 / migration 033) — only relevant
            for repository targets. Free-text input; the engine accepts
            branch / tag / SHA refs. Empty value = the engine uses the
            repository's default branch. A full GitHub-API-sourced
            dropdown is on the wishlist but out of scope here — requires
            a connected GitHub integration to enumerate refs. */}
        {selected?.type === 'repository' && (
          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Branch <span className="text-neutral-500">(optional)</span>
            </div>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              maxLength={255}
              placeholder="main"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <p className="mt-1 text-[11px] text-neutral-500">
              Branch, tag, or commit SHA. Leave empty to scan the repository&apos;s
              default branch.
            </p>
          </section>
        )}

        {/* Passive recon mode (--dns-only) — only relevant for domain targets.
            Engine PR #30; forwarded as STRIX_DNS_ONLY=1 by the worker. */}
        {selected?.type === 'domain' && (
          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Passive recon mode
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-2.5 transition-colors hover:border-neutral-700">
              <input
                type="checkbox"
                checked={dnsOnly}
                onChange={(e) => setDnsOnly(e.target.checked)}
                className="mt-0.5 accent-cyan-500"
              />
              <span className="text-sm leading-relaxed">
                <span className="font-medium text-neutral-200">Surface-map only — no active probing.</span>
                <span className="ml-1 text-[11.5px] text-neutral-500">
                  DNSSEC / CAA / MX / SPF / subdomain enumeration etc., but
                  no HTTP/TCP probes against the target's hosts. Useful for
                  pre-authorisation surface mapping or compliance-driven sweeps.
                </span>
              </span>
            </label>
          </section>
        )}

        {integrations.length > 0 && (
          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Integrations
            </div>
            <p className="mb-2 text-[11px] text-neutral-500">
              Authorize the agent to use connected GitHub, AWS, Kubernetes, etc.
            </p>
            <div className="space-y-1">
              {integrations.map((i) => (
                <label
                  key={i.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-1.5 text-sm transition-colors hover:border-neutral-700"
                >
                  <input
                    type="checkbox"
                    checked={integrationIds.includes(i.id)}
                    onChange={(e) =>
                      setIntegrationIds((cur) =>
                        e.target.checked ? [...cur, i.id] : cur.filter((id) => id !== i.id),
                      )
                    }
                    className="accent-cyan-500"
                  />
                  <span className="font-mono text-[10px] uppercase text-neutral-400">{i.type}</span>
                  <span className="text-neutral-200">{i.name}</span>
                </label>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            Instructions (optional)
          </div>
          <p className="mb-2 text-[11px] text-neutral-500">
            Test credentials, scope, or focus areas. Free-form text.
          </p>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={5}
            placeholder="Authenticate as user:pass and focus on IDOR vulnerabilities."
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
        </section>

        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !selected}
          className="rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Queuing…' : 'Start scan'}
        </button>
      </form>
    </div>
  );
}

export default function NewScanPage() {
  return (
    <Suspense fallback={null}>
      <NewScanInner />
    </Suspense>
  );
}
