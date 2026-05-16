import { notFound } from 'next/navigation';
import {
  ChevronRight,
  Target,
  Cpu,
  ArrowDownToLine,
  ArrowUpFromLine,
  DollarSign,
  Sparkles,
  History,
  CheckCircle2,
  Circle,
  Loader2,
  ClipboardCheck,
  Download,
  Package,
  RefreshCw,
  ShieldAlert,
  ExternalLink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ScanLiveView from '@/components/scan/scan-live-view';
import VendorRiskGauge from '@/components/scan/vendor-risk-gauge';
import MfaPostureBadge from '@/components/scan/mfa-posture-badge';
import CompliancePostureCard from '@/components/scan/compliance-posture-card';
import MonitoringPostureBadge from '@/components/scan/monitoring-posture-badge';
import CoverageBanner from '@/components/scan/coverage-banner';
import { AI_BRAND } from '@/lib/finding-theme';
import type {
  ScanRecurrenceSummary,
  ScanSummary,
  ScanTarget,
  ScanCoverage,
  RunMeta,
} from '@/lib/supabase/types';

// ---------------------------------------------------------------------------
// Engine event parsers (§19.1 Tier 1 slice 2). Read the structured events
// the worker has tailed into scan_events into the shapes the UI components
// expect. Engine event refs:
//   target.started / target.completed — engine PR #32
//   run.test_plan — engine PR #35
// ---------------------------------------------------------------------------

interface TargetState {
  target_id: string;
  value: string;
  type?: string;
  status: 'started' | 'completed';
  findings_total?: number;
}

interface PlannedCategory {
  name: string;
  description?: string;
}

interface TestPlanForUi {
  scan_mode: string | null;
  dns_only: boolean;
  per_target: Array<{
    target_id?: string;
    value?: string;
    type?: string;
    planned_categories: PlannedCategory[];
    skipped_categories?: PlannedCategory[];
  }>;
  summary_text?: string;
}

type EventRow = { event_type: string; payload: unknown; created_at: string };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseTargetEvents(events: EventRow[]): TargetState[] {
  // Engine emits target.started → target.completed per target; we collapse
  // to one entry per target_id, with status=completed when both fired.
  const map = new Map<string, TargetState>();
  for (const ev of events) {
    if (ev.event_type !== 'target.started' && ev.event_type !== 'target.completed') continue;
    const p = asObj(ev.payload);
    const inner = asObj(p.payload);
    const tid = (inner.target_id as string | undefined)
      ?? (p.target_id as string | undefined);
    if (!tid) continue;
    const existing = map.get(tid);
    const next: TargetState = {
      target_id: tid,
      value: (inner.value as string | undefined) ?? (p.value as string | undefined) ?? existing?.value ?? '',
      type: (inner.type as string | undefined) ?? (p.type as string | undefined) ?? existing?.type,
      status: ev.event_type === 'target.completed' ? 'completed' : 'started',
      findings_total: existing?.findings_total,
    };
    if (ev.event_type === 'target.completed') {
      const findings = asObj(inner.findings ?? p.findings);
      const total = findings.total;
      if (typeof total === 'number') next.findings_total = total;
    }
    // Don't downgrade completed → started.
    if (existing?.status === 'completed' && next.status === 'started') continue;
    map.set(tid, next);
  }
  return [...map.values()];
}

function parseTestPlan(events: EventRow[]): TestPlanForUi | null {
  const planEv = events.find((e) => e.event_type === 'run.test_plan');
  if (!planEv) return null;
  const p = asObj(planEv.payload);
  const inner = asObj(p.payload);
  const targetsRaw = (inner.targets ?? p.targets) as unknown;
  if (!Array.isArray(targetsRaw)) return null;
  const per_target = targetsRaw.map((t) => {
    const ot = asObj(t);
    const planned = Array.isArray(ot.planned_categories)
      ? (ot.planned_categories as unknown[]).map((c) => {
          const oc = asObj(c);
          return { name: String(oc.name ?? ''), description: oc.description as string | undefined };
        }).filter((c) => c.name)
      : [];
    const skipped = Array.isArray(ot.skipped_categories)
      ? (ot.skipped_categories as unknown[]).map((c) => {
          const oc = asObj(c);
          return { name: String(oc.name ?? ''), description: oc.description as string | undefined };
        }).filter((c) => c.name)
      : [];
    return {
      target_id: ot.target_id as string | undefined,
      value: ot.value as string | undefined,
      type: ot.type as string | undefined,
      planned_categories: planned,
      skipped_categories: skipped,
    };
  });
  return {
    scan_mode: (inner.scan_mode as string | undefined) ?? (p.scan_mode as string | undefined) ?? null,
    dns_only: Boolean(inner.dns_only ?? p.dns_only),
    per_target,
    summary_text: (inner.summary_text as string | undefined) ?? (p.summary_text as string | undefined),
  };
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

interface Props {
  params: { id: string };
}

export default async function ScanDetailPage({ params }: Props) {
  const supabase = createClient();
  const { data: scan } = await supabase.from('scans').select('*').eq('id', params.id).single();
  if (!scan) notFound();

  const { data: targets } = await supabase
    .from('scan_targets')
    .select('*')
    .eq('scan_id', params.id);

  // Cross-scan recurrence roll-up (pillar 1 item 5). Returns null when
  // this scan has no recurring findings — UI hides the section.
  const { data: recurrenceData } = await supabase.rpc(
    'scan_recurrence_summary',
    { p_scan_id: params.id },
  );
  const recurrence = recurrenceData as ScanRecurrenceSummary | null;
  const summary = (scan.summary ?? null) as ScanSummary | null;

  // Engine event consumption (§19.1 Tier 1 slice 2). The worker tails
  // events.jsonl into scan_events; here we pull the structured events we
  // surface in the UI.
  //
  //   target.started / target.completed (engine PR #32) — per-target progress
  //   run.test_plan (engine PR #35) — what categories will be tested
  const { data: scanEventsData } = await supabase
    .from('scan_events')
    .select('event_type, payload, created_at')
    .eq('scan_id', params.id)
    .in('event_type', ['target.started', 'target.completed', 'run.test_plan'])
    .order('created_at', { ascending: true });
  const targetEvents = parseTargetEvents(scanEventsData ?? []);
  const testPlan = parseTestPlan(scanEventsData ?? []);

  // Findings count for the coverage banner's copy variant. A 0-finding
  // scan with incomplete coverage is the most-misleading state, so the
  // banner uses a stronger "not a clean bill of health" warning when
  // findings_count is zero. Cheap head-count query — no payload bytes.
  const { count: findingsCount } = await supabase
    .from('findings')
    .select('id', { count: 'exact', head: true })
    .eq('scan_id', params.id);

  // Verify-rescan link (Tier A / migration 036). When this scan was
  // spawned from a finding's "Verify fix" button, fetch the linked
  // finding's title for the breadcrumb and the header badge. Best-effort
  // — a missing finding (deleted between launch and view) just hides
  // the breadcrumb and the badge without erroring.
  let verifyingFinding: { id: string; title: string } | null = null;
  if (scan.verifying_finding_id) {
    const { data: vf } = await supabase
      .from('findings')
      .select('id, title')
      .eq('id', scan.verifying_finding_id)
      .single();
    if (vf && typeof vf.title === 'string') {
      verifyingFinding = { id: vf.id, title: vf.title };
    }
  }

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/scans" className="transition-colors hover:text-neutral-300">
          Scans
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">{scan.run_name}</span>
      </nav>

      {verifyingFinding && (
        <section className="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.05] p-3.5">
          <div className="flex items-start gap-3">
            <RefreshCw className="mt-0.5 h-4 w-4 flex-shrink-0 text-cyan-300" strokeWidth={2.25} />
            <div className="min-w-0 space-y-0.5">
              <div className="text-[12.5px] font-medium text-cyan-100">
                Verifying a previously reported finding
              </div>
              <div className="truncate text-[11.5px] text-cyan-200/80">
                <Link
                  href={`/findings/${verifyingFinding.id}`}
                  className="hover:underline"
                >
                  {verifyingFinding.title}
                </Link>
              </div>
              <p className="pt-0.5 text-[11px] leading-relaxed text-cyan-200/60">
                A clean finish with no recurrence of the original fingerprint
                means the fix likely landed; the original finding stays at its
                current triage status until you mark it &ldquo;Fixed&rdquo;.
              </p>
            </div>
          </div>
        </section>
      )}

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-50">{scan.run_name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {/* CycloneDX SBOM viewer (engine PR #131 / wishlist §14.6 /
                migration 032). Surfaces only when the worker has uploaded
                a parseable SBOM. */}
            {scan.sbom_uploaded && (
              <Link
                href={`/scans/${scan.id}/sbom`}
                className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/20"
                title="CycloneDX 1.5 SBOM — every component the engine fingerprinted on this target"
              >
                <Package className="h-3.5 w-3.5" strokeWidth={2.25} />
                View SBOM
              </Link>
            )}
            {/* Auditor-grade evidence pack download (engine PR #129 /
                wishlist §14.4 row 1 / migration 030). Single biggest B2B
                unlock — the operator hands this zip to compliance teams.
                Hidden until the worker has flipped the flag, so a scan
                that pre-dates #129 (or had an upload error) doesn't
                dangle a broken download link. */}
            {scan.compliance_pack_uploaded && (
              <a
                href={`/api/scans/${scan.id}/compliance-pack`}
                className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:border-violet-500/50 hover:bg-violet-500/20"
                title="Auditor-grade evidence bundle — manifest, control attestations, coverage report, findings, signed events excerpt, SHA256 sums"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2.25} />
                Download compliance pack
              </a>
            )}
            {/* Phase A #5 / migration 062 — SARIF auto-uploaded to
                GitHub Code Scanning. Surfaces only when the worker
                successfully pushed at scan-finalize. The link goes
                to the repo's Code Scanning landing page (the
                per-upload URL works too but only after GitHub's
                async ingest completes, so the repo URL is the
                friendlier deeplink). */}
            {scan.code_scanning_url && (
              <a
                href={scan.code_scanning_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/20"
                title="SARIF uploaded to GitHub Code Scanning — findings render inline on PR diffs in the repo"
              >
                <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2.25} />
                View in Code Scanning
                <ExternalLink className="h-3 w-3 opacity-70" strokeWidth={2.5} />
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-400">
          <span className="rounded-md bg-neutral-900 px-2 py-0.5 font-medium ring-1 ring-neutral-800">
            {scan.scan_mode}
          </span>
          {scan.scope_mode && (
            <span className="rounded-md bg-neutral-900 px-2 py-0.5 font-medium ring-1 ring-neutral-800">
              {scan.scope_mode}
            </span>
          )}
          {scan.dns_only && (
            <span
              className="rounded-md bg-cyan-500/10 px-2 py-0.5 font-medium text-cyan-200 ring-1 ring-cyan-500/30"
              title="Passive recon mode (--dns-only) — no active probing of target hosts"
            >
              passive
            </span>
          )}
          {scan.llm_provider && (
            <span className="font-mono">{scan.llm_provider}</span>
          )}
          {scan.created_at && (
            <span>{new Date(scan.created_at).toLocaleString()}</span>
          )}
        </div>
      </header>

      {/* Preflight failure banner (engine PR #29). Distinct from a scan
          crash — the target wasn't reachable from the worker. */}
      {scan.preflight_failed && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
          <div className="flex items-start gap-3">
            <Target className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" strokeWidth={2.25} />
            <div className="space-y-1">
              <h2 className="text-sm font-medium text-amber-100">
                Target unreachable — preflight check failed
              </h2>
              <p className="text-[12.5px] leading-relaxed text-amber-200/80">
                {scan.error_message ?? 'The target did not resolve or no port answered within the preflight timeout. Verify the target is reachable from the worker (DNS, network, firewall) and re-run the scan.'}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Coverage banner (Tier A trust-gap fix / migration 039). When
          the engine's coverage.json says `status="incomplete"` or
          coverage_percent < 50%, render an amber warning ABOVE the
          vendor-risk / MFA / posture hero strip so an operator can't
          read "100/100 low risk" without first seeing "but the agent
          didn't actually run those checks". A clean coverage report
          implicitly hides the banner — no positive-state noise. */}
      {scan.coverage && (
        <CoverageBanner
          coverage={scan.coverage}
          findingCount={findingsCount ?? 0}
        />
      )}

      {/* Compliance / vendor-risk hero widgets (engine PRs #132 + #133,
          migration 031). Both pull from `scan.run_meta` which the worker
          persists from the engine's run_meta.json. The widgets are
          side-by-side on wide screens, stacked on narrow. Each one
          renders nothing when its source signal is absent so an older
          engine without these PRs gracefully shows neither. */}
      {(scan.run_meta?.vendor_risk
        || scan.run_meta?.mfa_attestation
        || scan.run_meta?.compliance_posture
        || scan.run_meta?.monitoring_posture) && (
        <section className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {scan.run_meta?.vendor_risk && (
            <VendorRiskGauge
              vendor_risk={scan.run_meta.vendor_risk}
              coverage={scan.coverage ?? null}
            />
          )}
          {scan.run_meta?.mfa_attestation && (
            <MfaPostureBadge mfa={scan.run_meta.mfa_attestation} />
          )}
          {scan.run_meta?.monitoring_posture && (
            <MonitoringPostureBadge posture={scan.run_meta.monitoring_posture} />
          )}
          {scan.run_meta?.compliance_posture && (
            <CompliancePostureCard posture={scan.run_meta.compliance_posture} />
          )}
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={DollarSign}
          label="Cost"
          value={
            scan.total_cost != null && Number(scan.total_cost) > 0
              ? `$${Number(scan.total_cost).toFixed(4)}`
              : '$0.0000'
          }
          accent="amber"
        />
        <StatTile
          icon={ArrowDownToLine}
          label="Input tokens"
          value={formatTokens(scan.total_input_tokens)}
          accent="cyan"
        />
        <StatTile
          icon={ArrowUpFromLine}
          label="Output tokens"
          value={formatTokens(scan.total_output_tokens)}
          accent="violet"
        />
        <StatTile
          icon={Cpu}
          label="AI agents"
          value={scan.agents_count != null ? String(scan.agents_count) : '0'}
          hint="See what each one tested ↓"
          href="#agents"
          accent="emerald"
        />
      </section>

      <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          <Target className="h-3.5 w-3.5" strokeWidth={2} />
          Targets
        </div>
        <ul className="mt-3 space-y-1.5">
          {targets?.map((t) => {
            // Engine target.started/completed events (PR #32) give us per-target
            // status. Match by value since scan_targets.id is a wrapper UUID,
            // distinct from the engine's stable target_id.
            const engineEntry = targetEvents.find(
              (te) => te.value === t.value || te.value === String(t.value),
            );
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-400 ring-1 ring-neutral-800">
                  {t.type}
                </span>
                <code className="font-mono text-neutral-200">{t.value}</code>
                {engineEntry && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${
                      engineEntry.status === 'completed'
                        ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30'
                        : 'bg-blue-500/15 text-blue-200 ring-blue-400/30'
                    }`}
                    title={
                      engineEntry.status === 'completed'
                        ? `Target completed${engineEntry.findings_total != null ? ` — ${engineEntry.findings_total} finding(s)` : ''}`
                        : 'Target in progress'
                    }
                  >
                    {engineEntry.status === 'completed' ? (
                      <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                    )}
                    {engineEntry.status === 'completed'
                      ? `Done${engineEntry.findings_total != null ? ` · ${engineEntry.findings_total}` : ''}`
                      : 'Running'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Test plan (engine PR #35). Renders the planned-categories list as
          a checklist before findings exist — closes the "blank dashboard
          until first finding" UX gap. */}
      {testPlan && testPlan.per_target.length > 0 && (
        <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            <ClipboardCheck className="h-3.5 w-3.5" strokeWidth={2} />
            Test plan
            {testPlan.scan_mode && (
              <span className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 ring-1 ring-neutral-800">
                {testPlan.scan_mode}
              </span>
            )}
            {testPlan.dns_only && (
              <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200 ring-1 ring-cyan-500/30">
                Passive recon mode
              </span>
            )}
          </div>
          {testPlan.summary_text && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-300">
              {testPlan.summary_text}
            </p>
          )}
          <div className="mt-3 space-y-3">
            {testPlan.per_target.map((pt, i) => (
              <div key={pt.target_id ?? i} className="space-y-1.5">
                {pt.value && (
                  <div className="flex items-center gap-2 text-[11.5px] text-neutral-400">
                    {pt.type && (
                      <span className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 ring-1 ring-neutral-800">
                        {pt.type}
                      </span>
                    )}
                    <code className="font-mono">{pt.value}</code>
                  </div>
                )}
                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {pt.planned_categories.map((c) => (
                    <li key={c.name} className="flex items-start gap-1.5 text-[11.5px] text-neutral-400">
                      <Circle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0 text-neutral-600" strokeWidth={2.5} />
                      <span>
                        <span className="text-neutral-200">{c.name.replace(/_/g, ' ')}</span>
                        {c.description && (
                          <span className="ml-1 text-neutral-500">— {c.description}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {scan.instruction_text && (
        <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/20 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Instructions
          </div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-300">{scan.instruction_text}</p>
        </section>
      )}

      {/* Plain-language scan summary (pillar 1 item 7). Generated by the
          worker post-triage; the JSONB on scans.summary persists between
          loads. Hidden until generated — non-summary scans render as
          before. The whole point is the screenshot-and-forward use case:
          calibrated honest tone, two short paragraphs, copyable. */}
      {summary && (
        <section className={`rounded-xl p-5 ${AI_BRAND.bgTint} ${AI_BRAND.ring}`}>
          <div className="mb-2.5 flex items-center gap-2">
            <Sparkles className={`h-3.5 w-3.5 ${AI_BRAND.iconColor}`} strokeWidth={2.25} />
            <h2 className={`text-[11px] font-semibold uppercase tracking-wider ${AI_BRAND.gradientText}`}>
              Scan summary
            </h2>
            <span className="text-[10.5px] text-neutral-500">
              {summary.stats.findings_total} finding{summary.stats.findings_total === 1 ? '' : 's'}
              {summary.stats.endpoints_touched > 0 &&
                ` · ${summary.stats.endpoints_touched} endpoint${summary.stats.endpoints_touched === 1 ? '' : 's'} touched`}
            </span>
          </div>
          <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-neutral-200">
            {summary.text}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-neutral-500">
            {summary.stats.fix_now > 0 && (
              <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-200 ring-1 ring-rose-400/30">
                {summary.stats.fix_now} fix-now
              </span>
            )}
            {summary.stats.fix_soon > 0 && (
              <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-orange-200 ring-1 ring-orange-400/30">
                {summary.stats.fix_soon} fix-soon
              </span>
            )}
            {summary.stats.monitor > 0 && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-200 ring-1 ring-amber-400/30">
                {summary.stats.monitor} monitor
              </span>
            )}
            {summary.stats.dismiss_or_fp > 0 && (
              <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-zinc-300 ring-1 ring-zinc-600/40">
                {summary.stats.dismiss_or_fp} dismissed
              </span>
            )}
            <span className="ml-auto font-mono text-neutral-600">
              {summary.model.replace('gemini/', '')}
            </span>
          </div>
        </section>
      )}

      {/* Cross-scan recurrence roll-up (pillar 1 item 5). Surfaces
          finding_occurrences data that already lives in the DB; the
          per-finding timeline lives on each card, this is the scan-level
          aggregation that answers "what did this rescan do?". */}
      {recurrence && recurrence.total > 0 && (
        <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
          <div className="mb-2.5 flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-neutral-400" strokeWidth={2.25} />
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Re-checked from prior scans
            </h2>
            <span className="text-[10.5px] text-neutral-500">
              {recurrence.total} finding{recurrence.total === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <RecurrenceTile label="Still active" count={recurrence.still_active} tone="amber" />
            <RecurrenceTile label="Fixed" count={recurrence.fixed} tone="emerald" />
            <RecurrenceTile label="Dismissed" count={recurrence.dismissed} tone="zinc" />
            <RecurrenceTile label="Reopened" count={recurrence.reopened} tone="rose" />
          </div>
        </section>
      )}

      <ScanLiveView
        scanId={params.id}
        initialStatus={scan.status}
        agentsCount={scan.agents_count ?? 0}
        initialHeartbeatAt={scan.last_heartbeat_at ?? null}
        initialCancelRequestedAt={scan.cancel_requested_at ?? null}
        initialErrorMessage={scan.error_message ?? null}
        initialExitCode={scan.exit_code ?? null}
        targets={(targets ?? []) as ScanTarget[]}
        coverage={(scan.coverage ?? null) as ScanCoverage | null}
        runMeta={(scan.run_meta ?? null) as RunMeta | null}
      />
    </div>
  );
}

const ACCENTS = {
  amber: 'text-amber-300/90 ring-amber-500/20',
  cyan: 'text-cyan-300/90 ring-cyan-500/20',
  violet: 'text-violet-300/90 ring-violet-500/20',
  emerald: 'text-emerald-300/90 ring-emerald-500/20',
} as const;

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
  hint,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  accent: keyof typeof ACCENTS;
  hint?: string;
  href?: string;
}) {
  const cls = ACCENTS[accent];
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
        <Icon className={`h-3 w-3 ${cls.split(' ')[0]}`} strokeWidth={2.25} />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-neutral-100">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10.5px] leading-snug text-neutral-500 transition-colors group-hover:text-cyan-300/80">
          {hint}
        </div>
      )}
    </>
  );
  const wrapperCls =
    'group block rounded-xl border border-neutral-800/80 bg-neutral-900/30 px-4 py-3 transition-colors';
  if (href) {
    return (
      <Link href={href} className={`${wrapperCls} hover:border-neutral-700`}>
        {body}
      </Link>
    );
  }
  return <div className={wrapperCls}>{body}</div>;
}

const RECURRENCE_TONE: Record<string, string> = {
  amber: 'text-amber-300',
  emerald: 'text-emerald-300',
  zinc: 'text-neutral-400',
  rose: 'text-rose-300',
};

function RecurrenceTile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: keyof typeof RECURRENCE_TONE;
}) {
  const dim = count === 0;
  return (
    <div className="rounded-md bg-neutral-900/60 px-2.5 py-2 ring-1 ring-neutral-800/80">
      <div
        className={`text-lg font-semibold tracking-tight ${
          dim ? 'text-neutral-700' : RECURRENCE_TONE[tone]
        }`}
      >
        {count}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
    </div>
  );
}
