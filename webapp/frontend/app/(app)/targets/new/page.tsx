'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import {
  ChevronRight,
  Code2,
  Globe,
  Network,
  Folder,
  Search,
  Calendar,
  Plug,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanFrequency } from '@/lib/supabase/types';
import type { TargetType } from '@/lib/target-config';
import TypeFields, { type AllFields } from '@/components/target/type-fields';
import InstructionPreview from '@/components/target/instruction-preview';

// ---------------------------------------------------------------------------
// Type catalog
// ---------------------------------------------------------------------------

const TYPES: {
  value: TargetType;
  label: string;
  example: string;
  Icon: LucideIcon;
  blurb: string;
}[] = [
  {
    value: 'repository',
    label: 'Git repository',
    example: 'https://github.com/me/myapp',
    Icon: Code2,
    blurb: 'Source-code review of a GitHub / GitLab / Bitbucket repo.',
  },
  {
    value: 'web_application',
    label: 'Deployed web app',
    example: 'https://myapp.com',
    Icon: Globe,
    blurb: 'Live HTTP target — agent crawls and probes rendered pages.',
  },
  {
    value: 'api',
    label: 'API endpoint',
    example: 'https://api.myapp.com',
    Icon: Plug,
    blurb:
      'JSON / GraphQL / gRPC API. Skips browser & DOM tools; runs OWASP API Top 10 specialists (BOLA, BFLA, mass-assignment, rate-limit) + OpenAPI / Swagger spec ingest.',
  },
  {
    value: 'domain',
    label: 'Domain',
    example: 'myapp.com',
    Icon: Globe,
    blurb: 'Surface mapping of a domain. Optionally enumerate subdomains.',
  },
  {
    value: 'ip_address',
    label: 'IP address',
    example: '203.0.113.10',
    Icon: Network,
    blurb: 'Network-level scan. Set ports + protocol below.',
  },
  {
    value: 'local_code',
    label: 'Local code path',
    example: '/home/me/myapp',
    Icon: Folder,
    blurb: 'Self-host only. Worker must have read access to the path.',
  },
];

function inferType(value: string): TargetType {
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(value) || /^git@/.test(value))
    return 'repository';
  if (/^https?:\/\//.test(value)) {
    // Best-effort `api` heuristic: api.* hostname, or a path that looks
    // like spec discovery (/openapi.json, /swagger.json, /v3/api-docs)
    // or versioned API (/v1, /v2, /api/v1, …). User can always override
    // via the type buttons — this is just the default.
    try {
      const u = new URL(value);
      if (/^api\./i.test(u.hostname)) return 'api';
      if (
        /\/(openapi|swagger)(\.json|\.yaml|\.yml)?\b/i.test(u.pathname) ||
        /\/v\d+\/api-docs\b/i.test(u.pathname) ||
        /^\/api(\/v\d+)?\b/i.test(u.pathname) ||
        /^\/v\d+\//i.test(u.pathname)
      ) {
        return 'api';
      }
    } catch {
      // malformed URL — fall through to web_application
    }
    return 'web_application';
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return 'ip_address';
  if (value.startsWith('./') || value.startsWith('/')) return 'local_code';
  return 'domain';
}

const EMPTY_FIELDS: AllFields = {
  branch: '',
  subdirectory: '',
  crawlSeeds: [],
  rateLimitQps: '',
  specUrl: '',
  subdomainExcludes: [],
  portSpec: '',
  protocols: '',
  pathExcludes: [],
  languageHints: [],
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NewTargetPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [typeOverride, setTypeOverride] = useState<TargetType | null>(null);
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<ScanFrequency>('manual');
  const [autoDiscover, setAutoDiscover] = useState(false);
  const [fields, setFields] = useState<AllFields>(EMPTY_FIELDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase A / migration 061 — repository targets can be bound to a
  // specific GitHub / GitLab / Bitbucket integration so the worker
  // clones with that integration's OAuth token. Without this, private
  // repos silently fail to clone.
  const [integrations, setIntegrations] = useState<
    { id: string; type: string; name: string }[]
  >([]);
  const [integrationId, setIntegrationId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('integrations')
      .select('id, type, name')
      .in('type', ['github', 'gitlab', 'bitbucket'])
      .eq('status', 'active')
      .then(({ data }) => setIntegrations((data ?? []) as typeof integrations));
    // Only repeat when the page mounts — integrations list doesn't change
    // mid-form. Eslint complains because `integrations` is in the deps
    // array conceptually, but we intentionally don't re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvedType: TargetType = typeOverride ?? (value ? inferType(value) : 'web_application');
  const config = useMemo(() => buildConfigForType(resolvedType, fields), [resolvedType, fields]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!value.trim()) {
      setError('Add a target value (URL, domain, repo, etc.).');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || value.trim(),
        type: resolvedType,
        value: value.trim(),
        description: description.trim() || undefined,
        scan_frequency: frequency,
        auto_discover: resolvedType === 'domain' ? autoDiscover : false,
        // Phase A / migration 061 — repository targets can be paired
        // with the GitHub / GitLab / Bitbucket integration that should
        // clone them.
        integration_id:
          resolvedType === 'repository' && integrationId ? integrationId : undefined,
        config,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to create target');
      return;
    }
    const { id } = await res.json();
    router.push(`/targets/${id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      {/* ===================== left: form ===================== */}
      <div className="space-y-6">
        <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
          <Link href="/targets" className="transition-colors hover:text-neutral-300">
            Targets
          </Link>
          <ChevronRight className="h-3 w-3" />
          <span className="text-neutral-300">New target</span>
        </nav>

        <header>
          <h1 className="text-3xl font-semibold tracking-tight">Add a target</h1>
          <p className="mt-1.5 max-w-xl text-sm text-neutral-400">
            A target is an asset you want to scan repeatedly. Fields below are optional and only
            apply to the matching type — leave them blank for sensible defaults.
          </p>
        </header>

        <form onSubmit={onSubmit} className="space-y-8">
          {/* ─────────── 1. About the target ─────────── */}
          <section className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
            <SectionHeader index={1} title="What are we scanning?" />
            <div className="space-y-5">
              <Field label="Value" hint="URL, repo, domain, IP, or local path. We'll guess the type.">
                <input
                  type="text"
                  required
                  autoFocus
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    // Switching the input typically means switching the type.
                    // Reset per-type fields so we don't carry stale values.
                    if (
                      typeOverride === null &&
                      e.target.value &&
                      inferType(e.target.value) !== resolvedType
                    ) {
                      setFields(EMPTY_FIELDS);
                    }
                  }}
                  placeholder="https://github.com/me/myapp"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                />
              </Field>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
                    Target type
                  </span>
                  {value && typeOverride === null && (
                    <span className="text-[10.5px] text-neutral-500">
                      auto-detected as{' '}
                      <span className="font-mono text-neutral-300">{resolvedType}</span>
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {TYPES.map((t) => {
                    const Icon = t.Icon;
                    const active = resolvedType === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => {
                          setTypeOverride(t.value);
                          setFields(EMPTY_FIELDS);
                        }}
                        className={`group flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left text-xs transition-colors ${
                          active
                            ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100'
                            : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900/60'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
                        <span className="text-[12px] font-medium">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  {TYPES.find((t) => t.value === resolvedType)?.blurb}
                </p>
              </div>

              <Field label="Name" hint="A human-friendly label. Defaults to the value.">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Production API"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                />
              </Field>
            </div>
          </section>

          {/* ─────────── 2. Configure the scan ─────────── */}
          <section className="space-y-4">
            <SectionHeader index={2} title="Configure the scan" />

            {/* Per-type config — the big visual moment */}
            <TypeFields type={resolvedType} value={fields} onChange={setFields} />

            {/* Phase A / migration 061 — repository targets can be
                bound to a GitHub / GitLab / Bitbucket integration so
                the worker clones private repos with that integration's
                OAuth token. Hidden when no eligible integration exists. */}
            {resolvedType === 'repository' && integrations.length > 0 && (
              <Field
                label="Clone via integration"
                hint="Pick the OAuth token the worker should use. Required for private repos; optional for public ones."
              >
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIntegrationId(null)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors ${
                      integrationId === null
                        ? 'bg-neutral-800 text-neutral-200 ring-neutral-700'
                        : 'bg-neutral-900/40 text-neutral-500 ring-neutral-800 hover:text-neutral-300'
                    }`}
                  >
                    No integration (public only)
                  </button>
                  {integrations.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => setIntegrationId(i.id)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors ${
                        integrationId === i.id
                          ? 'bg-cyan-500/15 text-cyan-100 ring-cyan-400/40'
                          : 'bg-neutral-900/40 text-neutral-400 ring-neutral-800 hover:text-neutral-100'
                      }`}
                    >
                      <span className="uppercase tracking-wider text-[9.5px] text-neutral-500 mr-1.5">
                        {i.type}
                      </span>
                      {i.name}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {resolvedType === 'repository' && integrations.length === 0 && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11.5px] text-amber-200/90">
                No GitHub / GitLab / Bitbucket integration connected yet. Public repos work
                without one; for private repos,{' '}
                <Link
                  href="/integrations"
                  className="font-medium text-amber-100 underline-offset-2 hover:underline"
                >
                  connect one
                </Link>
                {' '}first.
              </p>
            )}

            {/* Domain-only opt-in (auto-discover) */}
            {resolvedType === 'domain' && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 transition-colors hover:bg-emerald-500/10">
                <input
                  type="checkbox"
                  checked={autoDiscover}
                  onChange={(e) => setAutoDiscover(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-emerald-500 focus:ring-1 focus:ring-emerald-500/30"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
                    <Search className="h-3 w-3 text-emerald-300" strokeWidth={2.5} />
                    Discover subdomains via Certificate Transparency logs
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-400">
                    We&apos;ll look up{' '}
                    <span className="font-mono text-neutral-300">{value || 'this domain'}</span> in
                    public CT logs and suggest each discovered subdomain as a separate target. You
                    decide which to scan — nothing is auto-scanned. Free, takes ~5 seconds.
                  </div>
                </div>
              </label>
            )}

          </section>

          {/* ─────────── 3. Operations ─────────── */}
          <section className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
            <SectionHeader index={3} title="Operations" muted />
            <div className="space-y-5">
              <Field
                label="Scan frequency"
                hint="Manual today; scheduled scans land in a future release."
              >
                <div className="flex flex-wrap gap-2">
                  {(['manual', 'daily', 'weekly', 'monthly'] as ScanFrequency[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFrequency(f)}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                        frequency === f
                          ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30'
                          : 'bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800 hover:text-neutral-100'
                      }`}
                    >
                      <Calendar className="h-3 w-3" strokeWidth={2.25} />
                      {f}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Description (optional)">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="What is this target? Any context for whoever scans it next."
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                />
              </Field>
            </div>
          </section>

          {/* ─────────── submit ─────────── */}
          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting || !value.trim()}
              className="rounded-lg bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create target'}
            </button>
            <Link
              href="/targets"
              className="text-sm text-neutral-400 transition-colors hover:text-neutral-100"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>

      {/* ===================== right: sticky preview ===================== */}
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <InstructionPreview userInstruction="" type={resolvedType} config={config} />
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          When you start a scan against this target, your per-scan brief is{' '}
          <span className="text-neutral-300">prepended</span> to the configuration above —
          this preview shows only the part derived from this form.
        </p>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({
  index,
  title,
  muted,
}: {
  index: number;
  title: string;
  muted?: boolean;
}) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
          muted
            ? 'bg-neutral-800 text-neutral-400'
            : 'bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/30'
        }`}
      >
        {index}
      </span>
      <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-neutral-500">{hint}</div>}
    </label>
  );
}

function buildConfigForType(type: TargetType, raw: AllFields): Record<string, unknown> {
  switch (type) {
    case 'repository': {
      const out: Record<string, unknown> = {};
      if (raw.branch.trim()) out.branch = raw.branch.trim();
      if (raw.subdirectory.trim()) out.subdirectory = raw.subdirectory.trim();
      return out;
    }
    case 'web_application': {
      const out: Record<string, unknown> = {};
      if (raw.crawlSeeds.length) out.crawl_seeds = raw.crawlSeeds;
      const qps = parseInt(raw.rateLimitQps, 10);
      if (Number.isFinite(qps) && qps > 0) out.rate_limit_qps = qps;
      return out;
    }
    case 'api': {
      const out: Record<string, unknown> = {};
      if (raw.specUrl.trim()) out.spec_url = raw.specUrl.trim();
      const qps = parseInt(raw.rateLimitQps, 10);
      if (Number.isFinite(qps) && qps > 0) out.rate_limit_qps = qps;
      return out;
    }
    case 'domain': {
      const out: Record<string, unknown> = {};
      if (raw.subdomainExcludes.length) out.subdomain_excludes = raw.subdomainExcludes;
      return out;
    }
    case 'ip_address': {
      const out: Record<string, unknown> = {};
      if (raw.portSpec.trim()) out.port_spec = raw.portSpec.trim();
      if (raw.protocols) out.protocols = raw.protocols;
      return out;
    }
    case 'local_code': {
      const out: Record<string, unknown> = {};
      if (raw.pathExcludes.length) out.path_excludes = raw.pathExcludes;
      if (raw.languageHints.length) out.language_hints = raw.languageHints;
      return out;
    }
  }
}
