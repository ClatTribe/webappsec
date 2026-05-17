// Public auditor share-link landing — /audit/<token>.
//
// The auditor opens this URL with no auth. The token is the access
// control: an unguessable 32-byte random secret, server-validated by
// the SECURITY DEFINER `get_audit_share_payload` RPC which rejects
// unknown / revoked / expired tokens.
//
// v2 (migration 076) adds:
//   - Cross-framework mapping callouts — "this single observation
//     credits 5 frameworks" rendered as a chip on each control.
//   - Evidence-freshness chips (green <30d, amber 30-90d, red >90d).
//   - Per-control drill-in — click to reveal the raw evidence detail.
//   - Readiness-score trend (last 8 quarters per framework).
//   - Recent-activity timeline (last 30 days, filtered to auditor-
//     appropriate actions).
//   - JSON export — auditors get an offline-archivable bundle.
//
// The page falls back gracefully when an older deployment hasn't
// run the migration (data.version absent → v1 layout).

import Link from 'next/link';
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
  Download,
  Layers,
  Calendar,
  TrendingUp,
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

interface ControlMapping {
  group_key: string;
  group_name: string;
  framework: string;
  control_id: string;
  control_label: string;
}

interface ReadinessSnapshot {
  framework: string;
  quarter: string;
  score: number;
  breakdown: Record<string, unknown>;
  snapshot_at: string;
}

interface ActivityRow {
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface SharePayload {
  version?: number;
  org: { name: string; slug: string };
  link: { label: string | null; expires_at: string; access_count: number };
  compliance: ComplianceRow[];
  findings: FindingRow[];
  stats: {
    open_critical: number;
    open_high: number;
    total_findings: number;
    total_scans: number;
    stale_controls?: number;
    monitoring_since: string;
  };
  control_mappings?: ControlMapping[];
  readiness_history?: ReadinessSnapshot[];
  recent_activity?: ActivityRow[];
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

  // ---- Build cross-framework groupings ------------------------
  // For each control row we look up its group_key (if any) and tag
  // it with the *other* frameworks the same group covers. We never
  // collapse rows (auditors want to see "this is the SOC 2 row"
  // explicitly), but we annotate them.
  const mappings = data.control_mappings ?? [];
  const mapByFwControl: Record<string, ControlMapping> = {};
  const mapByGroupKey: Record<string, ControlMapping[]> = {};
  for (const m of mappings) {
    mapByFwControl[`${m.framework}:${m.control_id}`] = m;
    (mapByGroupKey[m.group_key] = mapByGroupKey[m.group_key] ?? []).push(m);
  }

  // Compliance grouped by framework.
  const byFramework = data.compliance.reduce<Record<string, ComplianceRow[]>>((acc, row) => {
    (acc[row.framework] = acc[row.framework] ?? []).push(row);
    return acc;
  }, {});

  // Readiness history grouped by framework (latest first per fw).
  const readinessByFw = (data.readiness_history ?? []).reduce<Record<string, ReadinessSnapshot[]>>(
    (acc, s) => {
      (acc[s.framework] = acc[s.framework] ?? []).push(s);
      return acc;
    },
    {},
  );

  const isV2 = (data.version ?? 1) >= 2;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Hero — frames the doc as auditor-grade evidence */}
      <header className="border-b border-neutral-900 bg-gradient-to-b from-neutral-900/40 to-neutral-950">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <div className="mb-3 flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              <FileLock className="h-3 w-3" />
              Audit share — confidential
            </div>
            {isV2 && (
              <Link
                href={`/api/audit-share/${params.token}/export`}
                prefetch={false}
                className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900/40 px-3 py-1 text-xs text-neutral-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
              >
                <Download className="h-3 w-3" />
                Download JSON
              </Link>
            )}
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
            <span>
              {data.link.access_count} prior access
              {data.link.access_count === 1 ? '' : 'es'}
            </span>
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
          <div className={`grid gap-3 ${isV2 ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4'}`}>
            <Stat
              label="Open critical"
              value={data.stats.open_critical}
              tone={data.stats.open_critical > 0 ? 'rose' : 'emerald'}
            />
            <Stat
              label="Open high"
              value={data.stats.open_high}
              tone={data.stats.open_high > 0 ? 'amber' : 'emerald'}
            />
            <Stat label="Findings (lifetime)" value={data.stats.total_findings} />
            <Stat label="Scans (lifetime)" value={data.stats.total_scans} />
            {isV2 && (
              <Stat
                label="Stale controls (>90d)"
                value={data.stats.stale_controls ?? 0}
                tone={(data.stats.stale_controls ?? 0) > 0 ? 'amber' : 'emerald'}
              />
            )}
          </div>
        </section>

        {/* Readiness trend — v2 only */}
        {isV2 && Object.keys(readinessByFw).length > 0 && (
          <section>
            <h2 className="mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <TrendingUp className="h-3.5 w-3.5" />
              Readiness trend (last 8 quarters per framework)
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(readinessByFw).map(([fw, snaps]) => (
                <ReadinessCard key={fw} framework={fw} snaps={snaps} />
              ))}
            </div>
          </section>
        )}

        {/* Compliance verdicts per framework */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Compliance posture (latest verdict per control)
          </h2>
          {Object.keys(byFramework).length === 0 ? (
            <p className="text-sm text-neutral-500">
              No compliance evidence ingested yet. The org&apos;s next scan
              will populate this.
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
                    <ControlRow
                      key={r.control_id}
                      row={r}
                      mapping={mapByFwControl[`${fw}:${r.control_id}`]}
                      siblingMappings={
                        mapByFwControl[`${fw}:${r.control_id}`]
                          ? mapByGroupKey[mapByFwControl[`${fw}:${r.control_id}`].group_key].filter(
                              (m) => !(m.framework === fw && m.control_id === r.control_id),
                            )
                          : []
                      }
                      isLast={i === rows.length - 1}
                      isV2={isV2}
                    />
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
              No findings in the last 90 days. (Look at the headline stats
              above for lifetime numbers.)
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

        {/* Recent activity timeline — v2 only */}
        {isV2 && data.recent_activity && data.recent_activity.length > 0 && (
          <section>
            <h2 className="mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <Activity className="h-3.5 w-3.5" />
              Recent governance activity (last 30 days)
            </h2>
            <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
              {data.recent_activity.slice(0, 30).map((a, i, arr) => (
                <ActivityRowView key={`${a.created_at}-${i}`} row={a} isLast={i === arr.length - 1} />
              ))}
            </div>
          </section>
        )}

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
          Generated by TensorShield · {new Date(data.generated_at).toISOString()} ·{' '}
          payload v{data.version ?? 1}
        </footer>
      </div>
    </main>
  );
}

// =============== Components ========================================

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
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
        {label}
      </div>
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: ComplianceRow['verdict'] }) {
  if (verdict === 'pass')
    return <CheckCircle2 className="h-4 w-4 text-emerald-300" strokeWidth={2.25} />;
  if (verdict === 'fail')
    return <AlertCircle className="h-4 w-4 text-rose-300" strokeWidth={2.25} />;
  if (verdict === 'warn')
    return <AlertTriangle className="h-4 w-4 text-amber-300" strokeWidth={2.25} />;
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

function FreshnessChip({ observedAt }: { observedAt: string | null }) {
  if (!observedAt) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ring-1 ring-neutral-600/40 text-neutral-400">
        not observed
      </span>
    );
  }
  const ageDays = Math.floor(
    (Date.now() - Date.parse(observedAt)) / (24 * 60 * 60 * 1000),
  );
  const tone =
    ageDays <= 30
      ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
      : ageDays <= 90
        ? 'bg-amber-500/10 text-amber-300 ring-amber-500/30'
        : 'bg-rose-500/10 text-rose-300 ring-rose-500/30';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${tone}`}
      title={`Last observed ${new Date(observedAt).toLocaleString()}`}
    >
      {ageDays}d
    </span>
  );
}

function ControlRow({
  row,
  mapping,
  siblingMappings,
  isLast,
  isV2,
}: {
  row: ComplianceRow;
  mapping: ControlMapping | undefined;
  siblingMappings: ControlMapping[];
  isLast: boolean;
  isV2: boolean;
}) {
  // Render the row with optional drill-in. The <details> element is
  // server-rendered + un-controlled, so the page is fully static —
  // no client JS, no hydration cost. Browsers handle expand/collapse
  // natively.
  const hasDetail =
    isV2 &&
    row.detail &&
    typeof row.detail === 'object' &&
    Object.keys(row.detail).length > 0;
  const hasSiblings = isV2 && siblingMappings.length > 0;

  if (!hasDetail && !hasSiblings) {
    return (
      <div
        className={`grid grid-cols-[auto_auto_1fr_auto_auto] items-start gap-3 px-4 py-3 ${
          isLast ? '' : 'border-b border-neutral-800/60'
        }`}
      >
        <VerdictIcon verdict={row.verdict} />
        <code className="font-mono text-[12px] text-neutral-300">{row.control_id}</code>
        <span className="text-sm text-neutral-100">{row.summary ?? '(no summary)'}</span>
        {isV2 && <FreshnessChip observedAt={row.observed_at} />}
        <span className="text-[10.5px] text-neutral-500">
          {row.observed_at ? new Date(row.observed_at).toLocaleDateString() : '—'}
        </span>
      </div>
    );
  }

  return (
    <details className={`group ${isLast ? '' : 'border-b border-neutral-800/60'}`}>
      <summary className="grid cursor-pointer grid-cols-[auto_auto_1fr_auto_auto] items-start gap-3 px-4 py-3 list-none transition-colors hover:bg-neutral-900/50">
        <VerdictIcon verdict={row.verdict} />
        <code className="font-mono text-[12px] text-neutral-300">{row.control_id}</code>
        <span className="text-sm text-neutral-100">{row.summary ?? '(no summary)'}</span>
        <FreshnessChip observedAt={row.observed_at} />
        <span className="text-[10.5px] text-neutral-500">
          {row.observed_at ? new Date(row.observed_at).toLocaleDateString() : '—'}
        </span>
      </summary>
      <div className="space-y-3 border-t border-neutral-800/60 bg-neutral-950/60 px-4 py-3">
        {hasSiblings && mapping && (
          <div>
            <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
              <Layers className="h-3 w-3" />
              Same observation credits {siblingMappings.length} other framework
              {siblingMappings.length === 1 ? '' : 's'} via{' '}
              <span className="text-neutral-400">{mapping.group_name}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {siblingMappings.map((s) => (
                <span
                  key={`${s.framework}:${s.control_id}`}
                  className="rounded border border-cyan-500/20 bg-cyan-500/5 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200"
                >
                  {s.framework}:{s.control_id}
                </span>
              ))}
            </div>
          </div>
        )}
        {hasDetail && row.detail && (
          <div>
            <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
              Evidence detail
            </div>
            <pre className="overflow-x-auto rounded-md border border-neutral-800/80 bg-neutral-900/60 p-3 font-mono text-[10.5px] leading-relaxed text-neutral-300">
              {JSON.stringify(row.detail, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function ReadinessCard({ framework, snaps }: { framework: string; snaps: ReadinessSnapshot[] }) {
  const sorted = [...snaps].sort((a, b) => a.quarter.localeCompare(b.quarter));
  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const delta = prev ? latest.score - prev.score : 0;
  const max = Math.max(...sorted.map((s) => s.score));
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-sm text-neutral-200">{framework}</span>
        <div className="text-right">
          <div className="text-2xl font-semibold text-neutral-100">{latest.score}</div>
          {prev && (
            <div className={`text-[10px] ${delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} vs {prev.quarter}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-end gap-1">
        {sorted.map((s) => {
          const h = max > 0 ? (s.score / 100) * 32 : 0;
          return (
            <div key={s.quarter} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-sm bg-cyan-500/30"
                style={{ height: `${Math.max(2, h)}px` }}
                title={`${s.quarter}: ${s.score}`}
              />
              <span className="font-mono text-[8.5px] text-neutral-500">
                {s.quarter.replace(/^\d{2}/, '')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityRowView({ row, isLast }: { row: ActivityRow; isLast: boolean }) {
  const verb = describeAction(row.action);
  return (
    <div
      className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 ${
        isLast ? '' : 'border-b border-neutral-800/60'
      }`}
    >
      <Calendar className="h-3.5 w-3.5 text-neutral-500" />
      <span className="text-[12.5px] text-neutral-200">
        <span className="text-neutral-400">{verb.label}</span>
        {verb.detail && (
          <span className="ml-1 text-neutral-500">— {verb.detail}</span>
        )}
      </span>
      <span className="text-[10.5px] text-neutral-500">
        {new Date(row.created_at).toLocaleString()}
      </span>
    </div>
  );
}

/** Translate an audit_log action string into auditor-readable English.
 *  We deliberately keep this terse — auditors scan the timeline, they
 *  don't read it line-by-line. Unknown actions fall back to the raw
 *  string so nothing gets hidden. */
function describeAction(action: string): { label: string; detail?: string } {
  const map: Record<string, string> = {
    'scan.started': 'Security scan started',
    'scan.finalized': 'Security scan finalized',
    'scan.completed': 'Security scan completed',
    'finding.triaged_real': 'Finding confirmed by reviewer',
    'finding.dismissed': 'Finding dismissed (false positive)',
    'finding.fixed': 'Finding fixed',
    'evidence_collector.run': 'Compliance evidence collector ran',
    'evidence_collector.enabled': 'Compliance evidence collector enabled',
    'evidence_collector.disabled': 'Compliance evidence collector disabled',
    'audit_share_link.created': 'Audit share link created',
    'audit_share_link.revoked': 'Audit share link revoked',
    'audit_share_link.accessed': 'Audit share link accessed',
    'questionnaire.created': 'Compliance questionnaire created',
    'questionnaire.completed': 'Compliance questionnaire completed',
    'custom_rule.create': 'Custom Semgrep rule added',
    'custom_rule.update': 'Custom Semgrep rule updated',
    'custom_rule.archive': 'Custom Semgrep rule archived',
    'compliance.evidence_ingested': 'Compliance evidence ingested',
  };
  return { label: map[action] ?? action };
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
