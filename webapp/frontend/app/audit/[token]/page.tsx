// Public auditor share-link landing — /audit/<token>.
//
// The auditor opens this URL with no auth. The token is the access
// control: an unguessable 32-byte random secret, server-validated by
// the SECURITY DEFINER `get_audit_share_payload` RPC which rejects
// unknown / revoked / expired tokens.
//
// This page is deliberately denser than the public trust page (#81).
// Auditors want the per-control verdict list, the recent findings
// detail, and the link metadata (expiry + access count) so they know
// they have a current, well-bounded snapshot.

import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileLock,
  Activity,
} from 'lucide-react';

// Live data — each load reads the latest verdicts. Short revalidate so
// the auditor doesn't see a stale snapshot during their review session.
export const revalidate = 60;
export const dynamic = 'force-dynamic';

interface ComplianceRow {
  framework: string;
  control_id: string;
  verdict: 'pass' | 'fail' | 'warn' | 'untested' | 'info';
  summary: string | null;
  observed_at: string | null;
  detail: Record<string, unknown> | null;
}

interface FindingRow {
  id: string;
  title: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | null;
  status: string;
  created_at: string;
  triaged_at: string | null;
}

interface SharePayload {
  org: { name: string; slug: string };
  link: { label: string | null; expires_at: string; access_count: number };
  compliance: ComplianceRow[];
  findings: FindingRow[];
  stats: {
    open_critical: number;
    open_high: number;
    total_findings: number;
    total_scans: number;
    monitoring_since: string;
  };
  generated_at: string;
}

async function fetchPayload(token: string): Promise<SharePayload | null> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.rpc('get_audit_share_payload', { p_token: token });
  if (error) {
    console.error('[audit share] rpc error', error);
    return null;
  }
  if (!data) return null;
  return data as unknown as SharePayload;
}

async function recordAccess(token: string) {
  // Fire-and-forget — we don't want a logging failure to block the
  // page render. No await; uses the anon key.
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    await supabase.rpc('record_audit_share_access', {
      p_token: token,
      p_ip: null,
      p_ua: null,
    });
  } catch {
    /* swallow */
  }
}

export async function generateMetadata({ params }: { params: { token: string } }) {
  const data = await fetchPayload(params.token);
  if (!data) return { title: 'Audit share · expired or invalid' };
  return {
    title: `Audit share · ${data.org.name}`,
    description: data.link.label ?? `Audit evidence for ${data.org.name}.`,
    robots: { index: false, follow: false },
  };
}

export default async function AuditSharePage({ params }: { params: { token: string } }) {
  const data = await fetchPayload(params.token);
  if (!data) notFound();
  await recordAccess(params.token);

  const expires = new Date(data.link.expires_at);
  const daysLeft = Math.max(
    0,
    Math.ceil((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );

  // Compliance grouped by framework + sub-grouped by verdict.
  const byFramework = data.compliance.reduce<Record<string, ComplianceRow[]>>((acc, row) => {
    (acc[row.framework] = acc[row.framework] ?? []).push(row);
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Hero — frames the doc as auditor-grade evidence */}
      <header className="border-b border-neutral-900 bg-gradient-to-b from-neutral-900/40 to-neutral-950">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
            <FileLock className="h-3 w-3" />
            Audit share — confidential
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {data.org.name}
            <span className="block text-base font-normal text-neutral-400">
              Security & compliance evidence
            </span>
          </h1>
          {data.link.label && (
            <p className="mt-2 text-sm text-neutral-300">{data.link.label}</p>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" />
              Link expires in {daysLeft} day{daysLeft === 1 ? '' : 's'}{' '}
              ({expires.toLocaleDateString()})
            </span>
            <span>·</span>
            <span>Generated {new Date(data.generated_at).toLocaleString()}</span>
            <span>·</span>
            <span>{data.link.access_count} prior access{data.link.access_count === 1 ? '' : 'es'}</span>
          </div>
          <p className="mt-4 max-w-3xl text-xs leading-relaxed text-neutral-500">
            This page is private to the holder of the URL. Access is logged
            with a timestamp on each load. The org can revoke this URL at
            any time.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-12 px-6 py-10">
        {/* Headline stats */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Overview
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Open critical" value={data.stats.open_critical} tone={data.stats.open_critical > 0 ? 'rose' : 'emerald'} />
            <Stat label="Open high" value={data.stats.open_high} tone={data.stats.open_high > 0 ? 'amber' : 'emerald'} />
            <Stat label="Findings (lifetime)" value={data.stats.total_findings} />
            <Stat label="Scans (lifetime)" value={data.stats.total_scans} />
          </div>
        </section>

        {/* Compliance verdicts per framework */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Compliance posture (latest verdict per control)
          </h2>
          {Object.keys(byFramework).length === 0 ? (
            <p className="text-sm text-neutral-500">
              No compliance evidence ingested yet. The org&apos;s next scan will populate this.
            </p>
          ) : (
            Object.entries(byFramework).map(([fw, rows]) => (
              <div key={fw} className="mb-6 last:mb-0">
                <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-mono text-neutral-200">{fw}</span>
                  <FrameworkScore rows={rows} />
                </div>
                <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
                  {rows.map((r, i) => (
                    <div
                      key={r.control_id}
                      className={`grid grid-cols-[auto_auto_1fr_auto] items-start gap-4 px-4 py-3 ${
                        i < rows.length - 1 ? 'border-b border-neutral-800/60' : ''
                      }`}
                    >
                      <VerdictIcon verdict={r.verdict} />
                      <code className="font-mono text-[12px] text-neutral-300">
                        {r.control_id}
                      </code>
                      <span className="text-sm text-neutral-100">
                        {r.summary ?? '(no summary)'}
                      </span>
                      <span className="text-[10.5px] text-neutral-500">
                        {r.observed_at ? new Date(r.observed_at).toLocaleDateString() : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>

        {/* Recent findings */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Findings (last 90 days, top 50)
          </h2>
          {data.findings.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No findings in the last 90 days. (Look at the headline stats above for lifetime
              numbers.)
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
              {data.findings.map((f, i) => (
                <div
                  key={f.id}
                  className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 ${
                    i < data.findings.length - 1 ? 'border-b border-neutral-800/60' : ''
                  }`}
                >
                  <SeverityChip severity={f.severity ?? 'info'} />
                  <span className="text-sm text-neutral-100">
                    {f.title ?? '(untitled finding)'}
                  </span>
                  <StatusChip status={f.status} />
                  <span className="text-[10.5px] text-neutral-500">
                    {new Date(f.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Evidence-chain attestation */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-5">
          <div className="text-xs uppercase tracking-wider text-neutral-400">
            Evidence chain
          </div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-300">
            Every scan that contributed to this page is signed via{' '}
            <code className="font-mono text-neutral-200">run.signature.json</code> — an HMAC chain
            that allows tamper-evidence verification per scan. Raw per-scan compliance packs are
            available on request from the org owner.
          </p>
        </section>

        <footer className="pt-8 text-center text-[10px] text-neutral-600">
          Generated by TensorShield · {new Date(data.generated_at).toISOString()}
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
  const color = {
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    rose: 'text-rose-300',
    neutral: 'text-neutral-200',
  }[tone];
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-4">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-400">{label}</div>
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: ComplianceRow['verdict'] }) {
  if (verdict === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-300" strokeWidth={2.25} />;
  if (verdict === 'fail') return <AlertCircle className="h-4 w-4 text-rose-300" strokeWidth={2.25} />;
  if (verdict === 'warn') return <AlertTriangle className="h-4 w-4 text-amber-300" strokeWidth={2.25} />;
  return <ShieldCheck className="h-4 w-4 text-neutral-500" strokeWidth={2.25} />;
}

function FrameworkScore({ rows }: { rows: ComplianceRow[] }) {
  const pass = rows.filter((r) => r.verdict === 'pass').length;
  const fail = rows.filter((r) => r.verdict === 'fail').length;
  const warn = rows.filter((r) => r.verdict === 'warn').length;
  return (
    <span className="text-xs text-neutral-400">
      <strong className="text-emerald-300">{pass}</strong> pass ·{' '}
      <strong className="text-amber-300">{warn}</strong> warn ·{' '}
      <strong className="text-rose-300">{fail}</strong> fail ·{' '}
      {rows.length - pass - warn - fail} other
    </span>
  );
}

function SeverityChip({ severity }: { severity: string }) {
  const theme: Record<string, string> = {
    critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    high: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    medium: 'bg-yellow-500/15 text-yellow-200 ring-yellow-500/30',
    low: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    info: 'bg-neutral-700/40 text-neutral-400 ring-neutral-600/40',
  };
  return (
    <span
      className={`inline-flex rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${
        theme[severity] ?? theme.info
      }`}
    >
      {severity}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const label =
    status === 'fixed'
      ? 'Fixed'
      : status === 'false_positive' || status === 'dismissed_by_ai'
      ? 'Dismissed (FP)'
      : status === 'wont_fix'
      ? "Won't fix"
      : status === 'triaged_real'
      ? 'Confirmed'
      : 'Open';
  const tone =
    status === 'fixed'
      ? 'bg-emerald-500/15 text-emerald-300'
      : status === 'open'
      ? 'bg-rose-500/15 text-rose-300'
      : 'bg-neutral-700/40 text-neutral-300';
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {label}
    </span>
  );
}
