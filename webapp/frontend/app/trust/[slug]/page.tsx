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
import { Sparkles, ShieldCheck, AlertTriangle, AlertCircle, Clock } from 'lucide-react';
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
  iso_27001:        'ISO 27001',
  pci_dss:          'PCI DSS',
  hipaa:            'HIPAA',
  gdpr:             'GDPR',
  fedramp_moderate: 'FedRAMP Moderate',
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

async function fetchTrustPage(slug: string): Promise<TrustPagePayload | null> {
  // Anon-key client. The RPC is granted to anon; RLS on the underlying
  // tables would deny direct reads. The function's opt-in check is the
  // security boundary.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase.rpc('get_trust_page_payload', {
    p_slug: slug,
  });
  if (error) {
    console.error('[trust page] rpc error', error);
    return null;
  }
  return (data as unknown as TrustPagePayload | null) ?? null;
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const data = await fetchTrustPage(params.slug);
  if (!data) {
    return { title: 'Trust page · Not published' };
  }
  return {
    title: `${data.org.name} · Security & Trust`,
    description: data.org.subtitle ?? `${data.org.name}'s continuous security monitoring, compliance posture, and recent improvements.`,
  };
}

export default async function TrustPage({ params }: { params: { slug: string } }) {
  const data = await fetchTrustPage(params.slug);
  if (!data) notFound();

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
              <Sparkles className="h-3 w-3" /> Maintained by Strix
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
          Maintained by Strix · This page does not collect cookies or trackers
        </footer>
      </div>
    </main>
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
