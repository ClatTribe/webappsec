'use client';

import Link from 'next/link';
import { AlertOctagon, ChevronRight, Layers } from 'lucide-react';
import type { Finding } from '@/lib/supabase/types';
import { isAttackPathFinding, patternDisplayName } from '@/lib/cloud-attack-path';

// Wishlist §17.4 — "Critical Attack Paths" card.
//
// Top-of-scan-detail aggregate for cloud_attack_path findings. The
// CISO's first-glance widget — one number ("5 critical attack paths")
// is more legible than "127 CSPM findings". Each path is grouped by
// pattern_id (cap_*) so duplicates of the same toxic-combo type
// collapse cleanly.
//
// Hidden when the scan produced no attack-path findings — keeps
// non-cloud scans visually unchanged.

interface Props {
  findings: Finding[];
}

interface GroupRow {
  patternId: string;
  count: number;
  severities: Record<string, number>;
  worstSeverity: string;
  findings: Finding[];
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
  high: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
  medium: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  low: 'bg-lime-500/15 text-lime-200 ring-lime-400/30',
  info: 'bg-neutral-700/40 text-neutral-200 ring-neutral-600/40',
};

export default function CriticalAttackPathsCard({ findings }: Props) {
  const pathFindings = findings.filter(isAttackPathFinding);
  if (pathFindings.length === 0) return null;

  const groups = groupByPattern(pathFindings);
  const criticalCount = pathFindings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  ).length;

  return (
    <section className="space-y-3 rounded-2xl border border-rose-500/30 bg-gradient-to-b from-rose-500/[0.05] to-rose-500/[0.02] p-5 ring-1 ring-rose-500/10">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30">
            <AlertOctagon className="h-5 w-5" strokeWidth={2.25} />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-rose-100">
              Critical attack paths
            </h2>
            <p className="text-[11.5px] text-rose-200/70">
              Toxic combinations of cloud misconfigurations that chain into exploit paths.
              Fixing any one link breaks the chain.
            </p>
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="text-3xl font-semibold text-rose-200">
            {criticalCount > 0 ? criticalCount : pathFindings.length}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-rose-200/70">
            {criticalCount > 0 ? 'critical · high' : 'total paths'}
          </div>
        </div>
      </header>

      <ul className="space-y-1.5">
        {groups.map((g) => (
          <PatternGroupRow key={g.patternId} group={g} />
        ))}
      </ul>

      {groups.length > 1 && (
        <div className="flex items-center gap-1.5 border-t border-rose-500/10 pt-2 text-[10.5px] text-rose-200/60">
          <Layers className="h-3 w-3" strokeWidth={2.25} />
          {groups.length} distinct pattern{groups.length === 1 ? '' : 's'} ·{' '}
          {pathFindings.length} occurrence{pathFindings.length === 1 ? '' : 's'} total
        </div>
      )}
    </section>
  );
}

function PatternGroupRow({ group }: { group: GroupRow }) {
  // Deep-link to the first finding in the group via the in-page
  // anchor convention used elsewhere (#finding-<id>). FindingCard
  // auto-expands when the URL hash matches.
  const anchor = `#finding-${group.findings[0]?.id ?? ''}`;
  const tone = SEVERITY_TONE[group.worstSeverity] ?? SEVERITY_TONE.info;
  return (
    <li>
      <Link
        href={anchor}
        className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2 transition-colors hover:border-rose-500/30 hover:bg-rose-500/[0.06]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-rose-100">
              {patternDisplayName(group.patternId)}
            </span>
            <span className="font-mono text-[10px] text-rose-200/60">{group.patternId}</span>
          </div>
          {group.count > 1 && (
            <div className="mt-0.5 text-[10.5px] text-rose-200/70">
              {group.count} occurrences across this scan
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${tone}`}
          >
            {group.worstSeverity}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-rose-300/60" strokeWidth={2.5} />
        </div>
      </Link>
    </li>
  );
}

function groupByPattern(findings: Finding[]): GroupRow[] {
  const byPattern = new Map<string, GroupRow>();
  for (const f of findings) {
    const patternId = extractPatternId(f);
    let g = byPattern.get(patternId);
    if (!g) {
      g = {
        patternId,
        count: 0,
        severities: {},
        worstSeverity: 'info',
        findings: [],
      };
      byPattern.set(patternId, g);
    }
    g.count += 1;
    g.findings.push(f);
    const sev = f.severity ?? 'info';
    g.severities[sev] = (g.severities[sev] ?? 0) + 1;
  }

  for (const g of byPattern.values()) {
    g.worstSeverity = SEVERITY_ORDER.find((s) => g.severities[s] > 0) ?? 'info';
  }

  return [...byPattern.values()].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.worstSeverity as (typeof SEVERITY_ORDER)[number]);
    const sb = SEVERITY_ORDER.indexOf(b.worstSeverity as (typeof SEVERITY_ORDER)[number]);
    if (sa !== sb) return sa - sb;
    return b.count - a.count;
  });
}

function extractPatternId(finding: Finding): string {
  // Prefer features.pattern_id (engine emits it explicitly), fall
  // back to the vuln_id which is the cap_<pattern> form per PR #294.
  const features = (finding.features ?? {}) as Record<string, unknown>;
  if (typeof features.pattern_id === 'string' && features.pattern_id.trim()) {
    return features.pattern_id.trim();
  }
  if (typeof finding.vuln_id === 'string' && finding.vuln_id.trim()) {
    return finding.vuln_id.trim().toLowerCase();
  }
  return 'unknown';
}
