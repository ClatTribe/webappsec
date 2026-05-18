// Public Living Trust Page — AISecurityEngineerUXRoadmap.md §10 Phase H.
//
// /trust/<org-slug> — anonymous-accessible URL each org can publish for
// prospects, auditors, and partners to bookmark. Updates in real time
// from each scan. The org explicitly opts in via
// organizations.trust_page_enabled (default false).
//
// The page is server-rendered. We call get_trust_page_payload(slug) —
// a SECURITY DEFINER RPC that's the ONLY entry point for anonymous
// compliance reads (direct table reads are RLS-denied). The function
// also enforces the opt-in gate, so a misconfigured route handler
// can't accidentally serve a private org's data.

import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Clock,
  Code2,
  Globe,
  Webhook,
  Cloud,
  Container,
  Network,
  Server,
  FileCode2,
  FlaskConical,
  Crosshair,
  Repeat,
  FileLock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Severity } from '@/lib/supabase/types';

// Disable ISR static caching — the trust page is the live posture.
// Browsers + CDN can cache for short windows (revalidate=60s) but the
// per-request render reads the latest evidence.
export const revalidate = 60;
export const dynamic = 'force-dynamic';

interface FrameworkPosture {
  framework: string;
  total: number;
  passing: number;
  failing: number;
  warning: number;
  untested: number;
  readiness_pct: number;
  // Engine PR #252 / wrapper migration 059 — auditor-grade freshness
  // rollup. `latest_observed_at` is max(observed_at) across the
  // framework's controls; `stale_controls` is the count whose engine-
  // emitted `expires_at` is now past. Both nullable for older engines
  // / pre-#252 evidence rows (no expires_at in detail).
  latest_observed_at: string | null;
  stale_controls: number;
}

interface RecentResolved {
  title: string | null;
  severity: Severity | null;
  resolved_at: string;
  status: string;
}

interface TrustPagePayload {
  org: {
    name: string;
    slug: string;
    subtitle: string | null;
    plan: string;
    published_at: string | null;
    monitoring_since: string;
  };
  frameworks: FrameworkPosture[];
  stats: {
    window_days: number;
    open_critical: number;
    open_high: number;
    fixed_last_30d: number;
    dismissed_last_30d: number;
    total_last_30d: number;
  };
  recent_resolved: RecentResolved[];
  generated_at: string;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  soc2_type_2:      'SOC 2 Type 2',
  soc2_type_1:      'SOC 2 Type 1',
  iso_27001:        'ISO 27001:2022',
  pci_dss:          'PCI DSS 4.0',
  hipaa:            'HIPAA',
  // Tier I #5 — additional frameworks the engine can now emit
  // evidence against (migration 065 seeded SAQ templates).
  nist_800_53:      'NIST 800-53',
  nist_800_171:     'NIST 800-171 / CMMC',
  gdpr:             'GDPR',
  fedramp_moderate: 'FedRAMP Moderate',
  fedramp_high:     'FedRAMP High',
  csa_caiq:         'CSA CAIQ',
  owasp_asvs:       'OWASP ASVS',
};

function frameworkLabel(id: string): string {
  return FRAMEWORK_LABELS[id] ?? id;
}

function readinessTone(pct: number): {
  label: string;
  bg: string;
  text: string;
  Icon: typeof ShieldCheck;
} {
  if (pct >= 90) return { label: 'Strong', bg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', text: 'text-emerald-300', Icon: ShieldCheck };
  if (pct >= 70) return { label: 'Improving', bg: 'bg-amber-500/15 text-amber-300 border-amber-500/30', text: 'text-amber-300', Icon: AlertTriangle };
  return { label: 'Needs work', bg: 'bg-rose-500/15 text-rose-300 border-rose-500/30', text: 'text-rose-300', Icon: AlertCircle };
}

// Tier II #12 — per-framework composite + quarterly history.
// Returned alongside the trust payload via a second anon-safe RPC.
interface TrustReadinessRow {
  framework: string;
  composite_pct: number;
  latest_quarter: string | null;
  latest_score: number | null;
  prev_quarter: string | null;
  prev_score: number | null;
}

// Tier II #13 — public-facing compensating control projection.
interface TrustCompensatingControl {
  framework: string;
  control_id: string;
  title: string;
  rationale_excerpt: string;
  effective_from: string;
  expires_at: string | null;
}

async function fetchTrustPage(
  slug: string,
): Promise<{
  payload: TrustPagePayload | null;
  readiness: TrustReadinessRow[];
  compensating: TrustCompensatingControl[];
}> {
  // Anon-key client. Both RPCs are granted to anon; the publication
  // gates inside each function are the security boundary.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

  const [
    { data: payloadData, error: payloadErr },
    { data: readinessRaw },
    { data: compensatingRaw },
  ] = await Promise.all([
    supabase.rpc('get_trust_page_payload', { p_slug: slug }),
    supabase.rpc('get_audit_readiness_for_trust', { p_slug: slug }),
    supabase.rpc('compensating_controls_for_trust', { p_slug: slug }),
  ]);

  if (payloadErr) {
    console.error('[trust page] rpc error', payloadErr);
    return { payload: null, readiness: [], compensating: [] };
  }

  // RPC returns out_-prefixed columns to dodge plpgsql shadowing;
  // strip the prefix here for ergonomic consumption.
  const readiness: TrustReadinessRow[] = ((readinessRaw ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      framework: (r.out_framework ?? r.framework) as string,
      composite_pct: (r.out_composite_pct ?? r.composite_pct) as number,
      latest_quarter: (r.out_latest_quarter ?? r.latest_quarter) as string | null,
      latest_score: (r.out_latest_score ?? r.latest_score) as number | null,
      prev_quarter: (r.out_prev_quarter ?? r.prev_quarter) as string | null,
      prev_score: (r.out_prev_score ?? r.prev_score) as number | null,
    }),
  );

  const compensating: TrustCompensatingControl[] = (
    (compensatingRaw ?? []) as Array<Record<string, unknown>>
  ).map((r) => ({
    framework: r.framework as string,
    control_id: r.control_id as string,
    title: r.title as string,
    rationale_excerpt: r.rationale_excerpt as string,
    effective_from: r.effective_from as string,
    expires_at: r.expires_at as string | null,
  }));

  return {
    payload: (payloadData as unknown as TrustPagePayload | null) ?? null,
    readiness,
    compensating,
  };
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const { payload } = await fetchTrustPage(params.slug);
  if (!payload) {
    return { title: 'Trust page · Not published' };
  }
  return {
    title: `${payload.org.name} · Security & Trust`,
    description: payload.org.subtitle ?? `${payload.org.name}'s continuous security monitoring, compliance posture, and recent improvements.`,
  };
}

export default async function TrustPage({ params }: { params: { slug: string } }) {
  const { payload: data, readiness, compensating } = await fetchTrustPage(params.slug);
  if (!data) notFound();

  // Index readiness by framework key for fast lookup inside the
  // existing per-framework card loop below.
  const readinessByFramework = new Map<string, TrustReadinessRow>();
  for (const r of readiness) readinessByFramework.set(r.framework, r);

  // Tier II #13 — index compensating controls by framework so the
  // per-framework card can show "+ 2 compensated" inline.
  const compensatingByFramework = new Map<string, TrustCompensatingControl[]>();
  for (const c of compensating) {
    if (!compensatingByFramework.has(c.framework)) compensatingByFramework.set(c.framework, []);
    compensatingByFramework.get(c.framework)!.push(c);
  }

  const monitoringStart = new Date(data.org.monitoring_since);
  const monthsMonitored = Math.max(
    1,
    Math.floor((Date.now() - monitoringStart.getTime()) / (30 * 24 * 60 * 60 * 1000)),
  );

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Hero */}
      <header className="border-b border-neutral-900 bg-gradient-to-b from-neutral-900/40 to-neutral-950">
        <div className="mx-auto max-w-4xl px-6 py-16">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300">
            <ShieldCheck className="h-3 w-3" />
            Continuous security monitoring
          </div>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            {data.org.name}
            <span className="block text-base font-normal text-neutral-400">
              Security & Trust
            </span>
          </h1>
          {data.org.subtitle && (
            <p className="mt-4 max-w-2xl text-neutral-300">{data.org.subtitle}</p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-neutral-400">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" /> Maintained by TensorShield
            </span>
            <span>·</span>
            <span>Monitoring for {monthsMonitored} {monthsMonitored === 1 ? 'month' : 'months'}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" />
              Updated {new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} today
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-12 px-6 py-12">
        {/* Coverage breadth — matches the landing page's "8 surfaces"
            claim so prospects who hit the trust page from marketing
            see the same product shape. Static brand claims, not org-
            specific data. */}
        <CoverageStrip />

        {/* What we actually do — three depth claims that mirror the
            landing's "we don't just flag, we prove" section. */}
        <DepthCallouts />

        {/* Frameworks */}
        <section>
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Compliance frameworks
          </h2>
          {data.frameworks.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No compliance evidence published yet. Check back after the next scan.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.frameworks.map((fw) => {
                const tone = readinessTone(fw.readiness_pct);
                const audit = readinessByFramework.get(fw.framework);
                const auditDelta =
                  audit?.composite_pct !== undefined && audit?.prev_score !== null
                    ? (audit.composite_pct as number) - (audit.prev_score as number)
                    : null;
                const comp = compensatingByFramework.get(fw.framework) ?? [];
                return (
                  <div
                    key={fw.framework}
                    className={`overflow-hidden rounded-2xl border bg-neutral-900/40 ${tone.bg}`}
                  >
                    <div className="border-b border-current/20 px-5 py-4">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-neutral-100">
                          {frameworkLabel(fw.framework)}
                        </div>
                        <tone.Icon className="h-4 w-4" />
                      </div>
                      <div className={`mt-1 text-3xl font-semibold ${tone.text}`}>
                        {fw.readiness_pct.toFixed(0)}%
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-neutral-400">
                        {tone.label}
                      </div>
                      {/* Tier II #12 — composite audit-readiness chip
                          + quarterly delta. Only renders when the
                          framework has audit-readiness data (the live
                          composite is always available if there's a
                          framework card; the delta requires a prior
                          quarter's snapshot). */}
                      {audit && (
                        <div className="mt-3 flex items-baseline gap-2 border-t border-current/10 pt-2.5 text-[11px]">
                          <span className="text-neutral-400">Audit-ready</span>
                          <span className="font-mono font-semibold text-neutral-100">
                            {audit.composite_pct}%
                          </span>
                          {auditDelta !== null && auditDelta !== 0 && audit.prev_quarter && (
                            <span
                              className={`font-mono text-[10px] ${
                                auditDelta > 0 ? 'text-emerald-300' : 'text-rose-300'
                              }`}
                              title={`vs. ${audit.prev_quarter}`}
                            >
                              {auditDelta > 0 ? '+' : ''}
                              {auditDelta} from {audit.prev_quarter}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-4 divide-x divide-neutral-800/60 text-center">
                      <div className="px-2 py-3 text-xs">
                        <div className="font-semibold text-emerald-300">{fw.passing}</div>
                        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-neutral-500">Pass</div>
                      </div>
                      <div className="px-2 py-3 text-xs">
                        <div className="font-semibold text-amber-300">{fw.warning}</div>
                        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-neutral-500">Warn</div>
                      </div>
                      <div className="px-2 py-3 text-xs">
                        <div className="font-semibold text-rose-300">{fw.failing}</div>
                        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-neutral-500">Fail</div>
                      </div>
                      <div className="px-2 py-3 text-xs">
                        <div className="font-semibold text-neutral-400">{fw.untested}</div>
                        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-neutral-500">Untested</div>
                      </div>
                    </div>
                    {/* Tier II #13 — Compensating controls roll-up.
                        Auditor-visible attestations the org has accepted
                        responsibility for. Renders only when the
                        framework has at least one active compensating
                        row. Truncated rationale_excerpt comes from the
                        server-side RPC (280-char public projection). */}
                    {comp.length > 0 && (
                      <details className="border-t border-current/10 px-4 py-2 text-[11px]">
                        <summary className="cursor-pointer text-amber-300/90">
                          <span className="font-semibold">+{comp.length}</span>{' '}
                          compensating control{comp.length === 1 ? '' : 's'} accepted
                        </summary>
                        <ul className="mt-2 space-y-2">
                          {comp.map((c) => (
                            <li
                              key={`${c.framework}:${c.control_id}:${c.effective_from}`}
                              className="rounded-md bg-neutral-950/40 px-2.5 py-1.5"
                            >
                              <div className="flex flex-wrap items-baseline gap-1.5">
                                <span className="font-mono text-[10.5px] text-amber-200">
                                  {c.control_id}
                                </span>
                                <span className="text-neutral-200">{c.title}</span>
                              </div>
                              <div className="mt-0.5 leading-relaxed text-neutral-400">
                                {c.rationale_excerpt}
                              </div>
                              <div className="mt-0.5 text-[10px] text-neutral-500">
                                accepted {new Date(c.effective_from).toLocaleDateString()}
                                {c.expires_at && (
                                  <span>
                                    {' '}
                                    · reviewed by {new Date(c.expires_at).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <FreshnessFooter
                      latestObservedAt={fw.latest_observed_at}
                      staleControls={fw.stale_controls}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Recent activity stats */}
        <section>
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Last {data.stats.window_days} days
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Issues found" value={data.stats.total_last_30d} />
            <Stat label="Fixed" value={data.stats.fixed_last_30d} tone="emerald" />
            <Stat label="Open critical" value={data.stats.open_critical} tone={data.stats.open_critical > 0 ? 'rose' : 'neutral'} />
            <Stat label="Open high" value={data.stats.open_high} tone={data.stats.open_high > 0 ? 'amber' : 'neutral'} />
          </div>
        </section>

        {/* Recent improvements */}
        {data.recent_resolved.length > 0 && (
          <section>
            <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Recent improvements
            </h2>
            <ol className="space-y-3 border-l-2 border-neutral-800 pl-5">
              {data.recent_resolved.map((r, i) => (
                <li key={i} className="relative">
                  <div className="absolute -left-[26px] top-1.5 h-2 w-2 rounded-full bg-emerald-500" />
                  <div className="text-xs text-neutral-400">
                    {new Date(r.resolved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {' · '}
                    {r.status === 'fixed' ? 'Fixed' : 'Dismissed (false positive / wontfix)'}
                  </div>
                  <div className="text-sm text-neutral-200">{r.title ?? '(untitled)'}</div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Footer attestation */}
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/30 p-6">
          <div className="text-xs uppercase tracking-wider text-neutral-400">Verifiable evidence chain</div>
          <p className="mt-2 text-sm text-neutral-300">
            Every scan that contributed to this page is signed via{' '}
            <code className="font-mono text-neutral-200">run.signature.json</code> (per-org HMAC chain).
            Auditors can request a time-bounded share-link for the full evidence pack from {data.org.name}.
          </p>
        </section>

        <footer className="pt-8 text-center text-[10px] text-neutral-600">
          Maintained by TensorShield · This page does not collect cookies or trackers
        </footer>
      </div>
    </main>
  );
}

// Engine PR #252 / wrapper migration 059 — auditor-grade evidence
// freshness footer for each framework card. Renders in three modes:
//
//   - stale  → amber: at least one control is past its engine-stamped
//     `expires_at` TTL. The trust page's prospect / auditor audience
//     should see this prominently — it's the difference between
//     "actively maintained" and "snapshot from Q3".
//   - aging  → neutral: no stale controls, but the most-recent scan is
//     >30 days old. We surface the age but don't alarm.
//   - fresh  → neutral muted: latest evidence is recent.
//
// Hidden entirely when latest_observed_at is null (no controls yet for
// this framework — handled by the empty-state above).
function FreshnessFooter({
  latestObservedAt,
  staleControls,
}: {
  latestObservedAt: string | null;
  staleControls: number;
}) {
  if (!latestObservedAt) return null;

  const observedMs = Date.parse(latestObservedAt);
  if (!Number.isFinite(observedMs)) return null;

  const ageDays = Math.max(0, Math.floor((Date.now() - observedMs) / (24 * 60 * 60 * 1000)));
  const isStale = staleControls > 0;

  const tone = isStale
    ? 'border-amber-500/30 bg-amber-500/[0.06] text-amber-200'
    : ageDays > 30
      ? 'border-neutral-800/60 bg-neutral-900/30 text-neutral-300'
      : 'border-neutral-800/40 bg-neutral-900/20 text-neutral-400';

  return (
    <div
      className={`flex items-center justify-between gap-3 border-t px-3 py-2 text-[10.5px] ${tone}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <Clock className="h-3 w-3" />
        Latest evidence {ageDays === 0 ? 'today' : `${ageDays}d ago`}
      </span>
      {isStale && (
        <span
          className="font-medium uppercase tracking-wider"
          title="Engine flagged these controls as past their evidence TTL (strix PR #252 — default 90-day expiry, configurable via STRIX_EVIDENCE_TTL_DAYS)."
        >
          {staleControls} stale
        </span>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'emerald' | 'amber' | 'rose' | 'neutral';
}) {
  const colorMap = {
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    rose: 'text-rose-300',
    neutral: 'text-neutral-200',
  };
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-4">
      <div className={`text-2xl font-semibold ${colorMap[tone]}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-400">{label}</div>
    </div>
  );
}

// ============================================================================
// Coverage strip + depth callouts
// ============================================================================
//
// Static brand claims that mirror the landing page. These intentionally
// don't pull per-org data — the message is "this is how TensorShield
// monitors *any* org, here's what we cover", not "your specific
// inventory". The framework + open-finding counts elsewhere on the
// page carry the per-org specifics.

function CoverageStrip() {
  const surfaces: { Icon: LucideIcon; label: string }[] = [
    { Icon: Code2, label: 'Source code' },
    { Icon: Globe, label: 'Web apps' },
    { Icon: Webhook, label: 'APIs' },
    { Icon: Cloud, label: 'Cloud accounts' },
    { Icon: Container, label: 'Container images' },
    { Icon: Network, label: 'Domains' },
    { Icon: Server, label: 'IP & infra' },
    { Icon: FileCode2, label: 'Local uploads' },
  ];
  return (
    <section>
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        Coverage — every attack surface, one agent
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {surfaces.map(({ Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-2.5 rounded-lg border border-neutral-800/80 bg-neutral-900/30 px-3 py-2.5"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-200 ring-1 ring-inset ring-cyan-500/20">
              <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
            </div>
            <span className="text-[12px] text-neutral-200">{label}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-neutral-500">
        Monitored continuously, not on quarterly cycles. Each surface
        feeds the same compliance evidence pipeline that powers this page.
      </p>
    </section>
  );
}

function DepthCallouts() {
  const items: {
    Icon: LucideIcon;
    tone: 'cyan' | 'violet' | 'emerald' | 'amber';
    title: string;
    body: string;
  }[] = [
    {
      Icon: FlaskConical,
      tone: 'violet',
      title: 'Verified exploits, not noise',
      body: 'Every high-severity finding gets an exploit attempt against a sandbox replica of the target. The finding only lands if the PoC succeeded.',
    },
    {
      Icon: Crosshair,
      tone: 'cyan',
      title: 'Reachability scoring',
      body: 'A dependency CVE in code that never executes is not the same as one in your auth path. We trace whether the vulnerable code is actually reachable before raising.',
    },
    {
      Icon: Repeat,
      tone: 'emerald',
      title: 'Closed-loop suppression',
      body: 'A dismissal becomes a rule with the reason on file. The same false positive never lands twice, and the audit trail shows when and why it was suppressed.',
    },
    {
      Icon: FileLock,
      tone: 'amber',
      title: 'Compliance, automatically',
      body: 'Per-control evidence across SOC 2 / ISO 27001 / PCI DSS 4.0 / HIPAA / NIST 800-53 is ingested from every scan. The framework cards below are live.',
    },
  ];
  const TONE: Record<
    'cyan' | 'violet' | 'emerald' | 'amber',
    { ring: string; bg: string; icon: string }
  > = {
    cyan: {
      ring: 'ring-cyan-500/20',
      bg: 'from-cyan-500/8',
      icon: 'bg-cyan-500/15 text-cyan-200',
    },
    violet: {
      ring: 'ring-violet-500/20',
      bg: 'from-violet-500/8',
      icon: 'bg-violet-500/15 text-violet-200',
    },
    emerald: {
      ring: 'ring-emerald-500/20',
      bg: 'from-emerald-500/8',
      icon: 'bg-emerald-500/15 text-emerald-200',
    },
    amber: {
      ring: 'ring-amber-500/20',
      bg: 'from-amber-500/8',
      icon: 'bg-amber-500/15 text-amber-200',
    },
  };
  return (
    <section>
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        How we monitor
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(({ Icon, tone, title, body }) => {
          const t = TONE[tone];
          return (
            <div
              key={title}
              className={`rounded-xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} to-transparent p-4 ring-1 ${t.ring}`}
            >
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-md ${t.icon} ring-1 ring-inset ring-white/5`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              </div>
              <h3 className="mt-2.5 text-[13.5px] font-semibold text-white">
                {title}
              </h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-400">
                {body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
