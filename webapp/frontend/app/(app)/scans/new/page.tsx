'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Plus, Target as TargetIcon, Network } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Integration, ScanMode, Target } from '@/lib/supabase/types';
import ImportsUploader, { type ImportRef } from '@/components/scan/imports-uploader';

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
  // Phase A #4 — "Scan this PR" diff mode. Engine accepts
  // `--scope-mode diff --diff-base <ref>`; the worker forwards as-is.
  // When `scopeMode === 'diff'`, the engine scans only the commits
  // between `diffBase` and the cloned ref (the branch field above,
  // or the repo default), which is the canonical "PR review" pattern.
  type ScopeMode = 'auto' | 'diff' | 'full';
  const [scopeMode, setScopeMode] = useState<ScopeMode>('auto');
  const [diffBase, setDiffBase] = useState<string>('');
  const [maxCost, setMaxCost] = useState<string>('');
  const [maxInputTokens, setMaxInputTokens] = useState<string>('');
  const [imports, setImports] = useState<ImportRef[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  // Phase A — auth credentials + advanced flags.
  type AuthMethod = 'none' | 'bearer' | 'cookie' | 'basic' | 'header' | 'login_creds';
  const [authMethod, setAuthMethod] = useState<AuthMethod>('none');
  const [authValue, setAuthValue] = useState<string>(''); // bearer / cookie / basic single-line
  const [authHeadersText, setAuthHeadersText] = useState<string>(''); // one "Name: Value" per line
  const [authLoginCredsText, setAuthLoginCredsText] = useState<string>(''); // one "user:pass" per line
  const [saveAuthOnTarget, setSaveAuthOnTarget] = useState(false);
  const [excludePathsText, setExcludePathsText] = useState<string>(''); // one glob per line
  const [rateLimitQps, setRateLimitQps] = useState<string>('');
  const [exportFormats, setExportFormats] = useState<string[]>([]);
  const [seedUrlsText, setSeedUrlsText] = useState<string>(''); // one URL per line
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
    // Pull the user's current org from the JWT app_metadata so the
    // ImportsUploader can stage files at `<org_id>/scan-imports/...`.
    // The server-side RPC re-validates the prefix in SQL but we want
    // the client to know up-front so the uploader can render the
    // right disabled state if there's no org context yet.
    supabase.auth.getSession().then(({ data: { session } }) => {
      const meta = session?.user.app_metadata as { org_id?: string } | undefined;
      if (meta?.org_id) setOrgId(meta.org_id);
    });
  }, [supabase, targetId]);

  const selected = targets.find((t) => t.id === targetId);

  // Phase A — derive the vault-bound plaintext from whichever auth-method
  // input the user filled in. Returns null when no auth was supplied,
  // matching the "none" path the API treats as omit.
  function deriveAuthPlaintext(): string | null {
    if (authMethod === 'none') return null;
    if (authMethod === 'header') {
      const lines = authHeadersText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      // Engine expects "Name: Value" strings — bare strings are echoed
      // as-is via STRIX_HEADERS. JSON-wrap so the engine's adapter sees
      // a single payload it can split.
      return JSON.stringify({ headers: lines });
    }
    if (authMethod === 'login_creds') {
      // "user:pass" per line → JSON list of {username, password}.
      const creds = authLoginCredsText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes(':'))
        .map((l) => {
          const idx = l.indexOf(':');
          return { username: l.slice(0, idx), password: l.slice(idx + 1) };
        });
      return creds.length > 0 ? JSON.stringify(creds) : null;
    }
    // bearer / cookie / basic — single-line literal
    return authValue.trim() || null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError('Pick a target.');
      return;
    }
    setSubmitting(true);
    const authPlaintext = deriveAuthPlaintext();
    const excludePaths = excludePathsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const seedUrls = seedUrlsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const res = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_id: selected.id,
        targets: [selected.value],
        scan_mode: scanMode,
        // Phase A #4 — diff-aware scope. The engine's --scope-mode
        // accepts {auto, diff, full}; the wrapper API sets the
        // default to 'auto' so omitting the field is safe.
        scope_mode:
          selected.type === 'repository' && scopeMode !== 'auto' ? scopeMode : undefined,
        // Phase A #4 — companion diff-base ref. Only forwarded when
        // scope_mode is 'diff'; ignored otherwise.
        diff_base:
          selected.type === 'repository' &&
          scopeMode === 'diff' &&
          diffBase.trim().length > 0
            ? diffBase.trim()
            : undefined,
        instruction_text: instruction.trim() || null,
        integration_ids: integrationIds,
        // Phase A / migration 061 — auth credentials + advanced engine
        // flags. The API route mints a vault secret for the plaintext
        // (when supplied), persists it on the scan row, and (when
        // `save_auth_on_target` is true) also stamps the auth method +
        // secret on the parent target as the new default.
        auth_method: authMethod === 'none' ? undefined : authMethod,
        auth_plaintext: authPlaintext ?? undefined,
        save_auth_on_target: authMethod !== 'none' && saveAuthOnTarget,
        exclude_paths: excludePaths.length > 0 ? excludePaths : undefined,
        rate_limit_qps: rateLimitQps.trim() ? Math.max(1, Math.floor(Number(rateLimitQps))) : undefined,
        export_formats: exportFormats.length > 0 ? exportFormats : undefined,
        seed_urls: seedUrls.length > 0 ? seedUrls : undefined,
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
        // Engine PR #113 — cost-cap self-exit gates. Forwarded as
        // `--max-cost <usd>` and `--max-input-tokens <n>`. Both
        // optional; the engine's `run.terminated{reason: budget_
        // exceeded}` event + exit-3 land on the dashboard with a
        // distinct "stopped: budget exceeded" message.
        max_cost: maxCost.trim() ? Number(maxCost) : undefined,
        max_input_tokens: maxInputTokens.trim()
          ? Math.floor(Number(maxInputTokens))
          : undefined,
        // Engine PR #141 — HAR / Burp project imports. The browser has
        // already uploaded each file to user-uploads at <org>/scan-
        // imports/<random>/<filename>; here we just send the metadata
        // refs. The worker downloads + places them in the per-scan
        // workdir before spawning strix.
        imports: imports.length > 0 ? imports : undefined,
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
              href="/assets/new"
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
                href="/assets/new"
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

        {/* HAR / Burp project upload (engine PR #141 / wishlist §15.2).
            Browser uploads to user-uploads bucket directly under the
            org's prefix; references piped to the worker via scans.imports
            JSONB (migration 035). The worker downloads the files into
            the per-scan workdir and adds an instruction line so the
            agent knows to call ingest_har_file / ingest_burp_file
            before its own recon. Hidden when there's no org context yet. */}
        {orgId && (
          <ImportsUploader orgId={orgId} imports={imports} onChange={setImports} />
        )}

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
          <section className="space-y-3">
            <div>
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
            </div>

            {/* Phase A #4 — "Scan this PR" diff-mode tile. Engine
                PR #117 surfaced as --scope-mode + --diff-base; this
                is the UX entry point. Three-state pill picker so the
                full-scan default is one click and the diff path
                shows its companion base-ref input only when relevant. */}
            <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3">
              <div className="mb-2">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-200">
                  Scan scope
                </div>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  Diff scope reviews only what changed against a base ref — the canonical PR-review
                  pattern. Use full scope for periodic audits.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { v: 'auto' as const, label: 'Auto', hint: "Engine picks based on target shape" },
                    { v: 'full' as const, label: 'Full scan', hint: 'Audit the whole repository' },
                    { v: 'diff' as const, label: 'PR diff', hint: 'Review only changes vs the base ref' },
                  ]
                ).map(({ v, label, hint }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setScopeMode(v)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      scopeMode === v
                        ? 'bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40'
                        : 'bg-neutral-900/40 text-neutral-400 ring-1 ring-neutral-800 hover:text-neutral-100'
                    }`}
                    title={hint}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {scopeMode === 'diff' && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                    Base ref
                  </div>
                  <input
                    type="text"
                    value={diffBase}
                    onChange={(e) => setDiffBase(e.target.value)}
                    maxLength={255}
                    placeholder="origin/main"
                    className="w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Engine computes <code>{diffBase || 'origin/main'}..{branch || 'HEAD'}</code> and
                    scans only files touched in those commits. Common values:{' '}
                    <button
                      type="button"
                      onClick={() => setDiffBase('origin/main')}
                      className="font-mono text-neutral-300 underline-offset-2 hover:underline"
                    >
                      origin/main
                    </button>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => setDiffBase('origin/master')}
                      className="font-mono text-neutral-300 underline-offset-2 hover:underline"
                    >
                      origin/master
                    </button>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => setDiffBase('origin/develop')}
                      className="font-mono text-neutral-300 underline-offset-2 hover:underline"
                    >
                      origin/develop
                    </button>
                    .
                  </p>
                </div>
              )}
            </div>
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

        {/* Cost cap (engine PR #113 / migration 034). Both fields
            optional; either or both may be set. The engine's
            `--max-cost` self-exits when LLM cost crosses the
            threshold; `--max-input-tokens` self-exits on token usage.
            We don't enforce per-org plan ceilings here — those are a
            future billing-tier follow-up. */}
        <section>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            Budget cap <span className="text-neutral-500">(optional)</span>
          </div>
          <p className="mb-2 text-[11px] text-neutral-500">
            Stop the scan automatically if it crosses one of these limits.
            Either / both leave blank for no cap. The dashboard surfaces
            "stopped: budget exceeded" if a cap trips.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-medium uppercase tracking-wider text-neutral-400">
                Max cost (USD)
              </span>
              <input
                type="number"
                value={maxCost}
                onChange={(e) => setMaxCost(e.target.value)}
                step="0.10"
                min="0"
                placeholder="e.g. 5.00"
                className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-medium uppercase tracking-wider text-neutral-400">
                Max input tokens
              </span>
              <input
                type="number"
                value={maxInputTokens}
                onChange={(e) => setMaxInputTokens(e.target.value)}
                step="1"
                min="0"
                placeholder="e.g. 500000"
                className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            </label>
          </div>
        </section>

        {/* Phase A / migration 061 — authentication credentials.
            Without auth the scanner only sees the unauthenticated 30%
            of any real app, which makes the `api` target type
            unusable. The picker covers the five methods the engine
            recognises: bearer / cookie / basic / header / login_creds.
            Plaintext goes to vault on submit; the worker decrypts at
            scan time and forwards via STRIX_AUTH_* env vars. */}
        {selected && selected.type !== 'ip_address' && (
          <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-200">
                  Authentication
                </div>
                <p className="mt-0.5 text-[11px] text-neutral-500">
                  Pre-authorise the scanner so it can probe logged-in surfaces. Stored encrypted in the
                  vault; never logged in argv.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(['none', 'bearer', 'cookie', 'basic', 'header', 'login_creds'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMethod(m)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    authMethod === m
                      ? 'bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40'
                      : 'bg-neutral-900/40 text-neutral-400 ring-1 ring-neutral-800 hover:text-neutral-100'
                  }`}
                >
                  {m === 'login_creds' ? 'login creds' : m}
                </button>
              ))}
            </div>
            {authMethod === 'bearer' && (
              <input
                type="text"
                autoComplete="off"
                value={authValue}
                onChange={(e) => setAuthValue(e.target.value)}
                placeholder="eyJhbGciOiJI…  (the bearer token, no 'Bearer ' prefix)"
                className="mt-3 w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            )}
            {authMethod === 'cookie' && (
              <input
                type="text"
                autoComplete="off"
                value={authValue}
                onChange={(e) => setAuthValue(e.target.value)}
                placeholder="session=abc123; csrf=def456"
                className="mt-3 w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            )}
            {authMethod === 'basic' && (
              <input
                type="text"
                autoComplete="off"
                value={authValue}
                onChange={(e) => setAuthValue(e.target.value)}
                placeholder="username:password"
                className="mt-3 w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            )}
            {authMethod === 'header' && (
              <textarea
                value={authHeadersText}
                onChange={(e) => setAuthHeadersText(e.target.value)}
                rows={3}
                placeholder={'X-API-Key: abc123\nX-Tenant: acme-prod'}
                className="mt-3 w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            )}
            {authMethod === 'login_creds' && (
              <>
                <textarea
                  value={authLoginCredsText}
                  onChange={(e) => setAuthLoginCredsText(e.target.value)}
                  rows={3}
                  placeholder={'admin@example.com:hunter2\nuser1@example.com:pass1'}
                  className="mt-3 w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                />
                <p className="mt-1.5 text-[10.5px] text-neutral-500">
                  One <code>user:pass</code> pair per line. The agent will try each one via the
                  <code> scan_auth_flow</code> tool.
                </p>
              </>
            )}
            {authMethod !== 'none' && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-neutral-400">
                <input
                  type="checkbox"
                  checked={saveAuthOnTarget}
                  onChange={(e) => setSaveAuthOnTarget(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
                />
                Save as the default for <span className="font-mono text-neutral-300">{selected.name}</span> so I don&apos;t have to re-enter it next scan.
              </label>
            )}
          </section>
        )}

        {/* Phase A — advanced engine flags. Optional, collapsed by
            default. Covers exclude-paths (production safety), rate-
            limit, seed URLs (web_application), GRC direct exports. */}
        <details className="group rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3">
          <summary className="flex cursor-pointer items-center justify-between text-[12px] font-semibold uppercase tracking-wider text-neutral-300 hover:text-neutral-100">
            <span>Advanced</span>
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-3 space-y-4">
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                Exclude paths
              </div>
              <p className="mb-1.5 text-[11px] text-neutral-500">
                Globs the agent must skip. Helpful for production traffic — keep <code>/admin/*</code> out of probing.
              </p>
              <textarea
                value={excludePathsText}
                onChange={(e) => setExcludePathsText(e.target.value)}
                rows={3}
                placeholder={'/admin/**\n/billing/**\n/internal/**'}
                className="w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                Outbound rate limit (req/s)
              </div>
              <p className="mb-1.5 text-[11px] text-neutral-500">
                Cap the agent&apos;s outbound traffic. Stay low for prod (5–10).
              </p>
              <input
                type="number"
                min={1}
                max={1000}
                value={rateLimitQps}
                onChange={(e) => setRateLimitQps(e.target.value)}
                placeholder="10"
                className="w-32 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            </div>
            {selected && (selected.type === 'web_application' || selected.type === 'api') && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                  Seed URLs
                </div>
                <p className="mb-1.5 text-[11px] text-neutral-500">
                  Pre-load specific URLs into the crawler so the agent starts from the right place.
                </p>
                <textarea
                  value={seedUrlsText}
                  onChange={(e) => setSeedUrlsText(e.target.value)}
                  rows={3}
                  placeholder={'https://app.example.com/dashboard\nhttps://app.example.com/api/v1/users'}
                  className="w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[12px] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                />
              </div>
            )}
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                GRC direct exports
              </div>
              <p className="mb-1.5 text-[11px] text-neutral-500">
                Engine writes one <code>grc_export_&lt;platform&gt;.json</code> file per pick — ready to import into the platform.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(['vanta', 'drata', 'hyperproof', 'secureframe', 'servicenow', 'generic'] as const).map(
                  (fmt) => {
                    const active = exportFormats.includes(fmt);
                    return (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() =>
                          setExportFormats((prev) =>
                            active ? prev.filter((f) => f !== fmt) : [...prev, fmt],
                          )
                        }
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          active
                            ? 'bg-violet-500/15 text-violet-100 ring-1 ring-violet-400/40'
                            : 'bg-neutral-900/40 text-neutral-400 ring-1 ring-neutral-800 hover:text-neutral-100'
                        }`}
                      >
                        {fmt}
                      </button>
                    );
                  },
                )}
              </div>
            </div>
          </div>
        </details>

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
