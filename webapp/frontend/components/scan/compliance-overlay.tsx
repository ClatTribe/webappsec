'use client';

import { useMemo, useState } from 'react';
import {
  ChevronRight,
  Scale,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';
import type { Finding, ComplianceControls } from '@/lib/supabase/types';
import { SEVERITY_THEME } from '@/lib/finding-theme';

// Engine PR #103 + wishlist §14.4 row 4 — compliance overlay panel.
//
// Groups findings by control framework × control id so an auditor or
// compliance lead can answer "which controls have findings against
// them?" without scrolling the flat severity-sorted list.
//
// Data already lives on every finding (migration 024): `compliance_
// controls` JSONB with the 7-framework shape. The engine populates it
// during ingest from `vulnerabilities.json` (PR #42); we just regroup
// here client-side. No new schema; no new fetch.
//
// Layout:
//   • Framework tabs (PCI / SOC2 / HIPAA / ISO / NIST / OWASP / GDPR)
//     with finding-count badges. Frameworks with zero findings are
//     hidden — operator's eye doesn't waste bandwidth on empty panes.
//   • Per-control rows with severity-coloured count chips, expandable
//     to the matching findings.
//   • Anchor links from each finding row to the FindingCard's
//     `#finding-<id>` anchor — operator one-click jumps to the casefile.

const FRAMEWORK_ORDER: Array<{
  key: keyof ComplianceControls;
  label: string;
  short: string;
}> = [
  { key: 'pci_dss',        label: 'PCI DSS',                       short: 'PCI' },
  { key: 'soc2',           label: 'SOC 2',                         short: 'SOC2' },
  { key: 'hipaa',          label: 'HIPAA',                         short: 'HIPAA' },
  { key: 'iso_27001',      label: 'ISO 27001',                     short: 'ISO' },
  { key: 'nist_800_53',    label: 'NIST 800-53',                   short: 'NIST' },
  { key: 'gdpr',           label: 'GDPR',                          short: 'GDPR' },
  { key: 'owasp',          label: 'OWASP',                         short: 'OWASP' },
  // Engine PR #289 — CIS Cloud benchmarks (CSPM + IaC scans). Listed
  // last so existing app-side scans render unchanged; the CSPM tabs
  // appear only when the underlying findings carry their keys.
  { key: 'cis_aws',        label: 'CIS AWS Foundations',           short: 'CIS AWS' },
  { key: 'cis_gcp',        label: 'CIS GCP',                       short: 'CIS GCP' },
  { key: 'cis_azure',      label: 'CIS Azure',                     short: 'CIS Azure' },
  { key: 'cis_kubernetes', label: 'CIS Kubernetes',                short: 'CIS K8s' },
  { key: 'cis_docker',     label: 'CIS Docker',                    short: 'CIS Docker' },
];

interface ControlGroup {
  control: string;
  findings: Finding[];
  /** Highest severity in the group — used for the pill colour and for
   *  ordering controls within the framework tab. */
  worst: keyof typeof SEVERITY_THEME;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function worstSeverity(items: Finding[]): keyof typeof SEVERITY_THEME {
  let worstKey: string = 'info';
  let worstRank = 0;
  for (const f of items) {
    const k = (f.severity ?? 'info') as string;
    const r = SEVERITY_RANK[k] ?? 0;
    if (r > worstRank) {
      worstRank = r;
      worstKey = k;
    }
  }
  return worstKey as keyof typeof SEVERITY_THEME;
}

function groupByFramework(
  findings: Finding[],
): Map<keyof ComplianceControls, ControlGroup[]> {
  const out = new Map<keyof ComplianceControls, Map<string, Finding[]>>();

  for (const f of findings) {
    const cc = f.compliance_controls;
    if (!cc) continue;
    for (const fw of FRAMEWORK_ORDER) {
      const ids = cc[fw.key];
      if (!Array.isArray(ids) || ids.length === 0) continue;
      let bucket = out.get(fw.key);
      if (!bucket) {
        bucket = new Map<string, Finding[]>();
        out.set(fw.key, bucket);
      }
      for (const raw of ids) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (!id) continue;
        const list = bucket.get(id);
        if (list) list.push(f);
        else bucket.set(id, [f]);
      }
    }
  }

  // Materialise to ControlGroup[] sorted by severity (worst first), then
  // by finding count desc, then lexicographic.
  const result = new Map<keyof ComplianceControls, ControlGroup[]>();
  for (const [fw, controls] of out) {
    const groups: ControlGroup[] = [];
    for (const [control, items] of controls) {
      groups.push({ control, findings: items, worst: worstSeverity(items) });
    }
    groups.sort((a, b) => {
      const da = SEVERITY_RANK[a.worst] ?? 0;
      const db = SEVERITY_RANK[b.worst] ?? 0;
      if (db !== da) return db - da;
      if (b.findings.length !== a.findings.length) return b.findings.length - a.findings.length;
      return a.control.localeCompare(b.control);
    });
    result.set(fw, groups);
  }
  return result;
}

export default function ComplianceOverlay({ findings }: { findings: Finding[] }) {
  const grouped = useMemo(() => groupByFramework(findings), [findings]);
  const [open, setOpen] = useState(false);
  const [activeFramework, setActiveFramework] =
    useState<keyof ComplianceControls | null>(null);
  const [expandedControls, setExpandedControls] = useState<Set<string>>(new Set());

  const populated = FRAMEWORK_ORDER.filter((fw) => (grouped.get(fw.key)?.length ?? 0) > 0);

  if (populated.length === 0) {
    // Nothing to overlay. We hide the entire section so the scan page
    // doesn't dangle an empty "Compliance overlay" affordance for runs
    // whose findings carry no compliance_controls (older engines, info-
    // only scans, etc.).
    return null;
  }

  const currentFw =
    activeFramework
    ?? populated[0].key;
  const currentGroups = grouped.get(currentFw) ?? [];

  const totalFindings = populated.reduce(
    (acc, fw) =>
      acc
      + (grouped.get(fw.key) ?? []).reduce((s, g) => s + g.findings.length, 0),
    0,
  );

  const toggleControl = (key: string) => {
    setExpandedControls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-neutral-900/50"
      >
        <div className="flex items-center gap-2.5">
          <ChevronRight
            className={`h-3.5 w-3.5 text-neutral-600 transition-transform ${open ? 'rotate-90 text-neutral-300' : ''}`}
            strokeWidth={2.5}
          />
          <Scale className="h-3.5 w-3.5 text-violet-300" strokeWidth={2.25} />
          <span className="text-[13px] font-medium text-neutral-300">
            Compliance overlay
          </span>
          <span className="text-[11px] text-neutral-500">
            {populated.length} framework{populated.length === 1 ? '' : 's'} · {totalFindings} mapped finding{totalFindings === 1 ? '' : 's'}
          </span>
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t border-neutral-800/60 bg-neutral-950/30 p-5">
          {/* Framework tab strip — only frameworks with mapped findings appear. */}
          <div className="flex flex-wrap gap-1.5">
            {populated.map((fw) => {
              const count = (grouped.get(fw.key) ?? []).reduce(
                (s, g) => s + g.findings.length,
                0,
              );
              const isActive = currentFw === fw.key;
              return (
                <button
                  key={String(fw.key)}
                  type="button"
                  onClick={() => setActiveFramework(fw.key)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium ring-1 transition-colors ${
                    isActive
                      ? 'bg-violet-500/15 text-violet-200 ring-violet-400/30'
                      : 'bg-neutral-900/40 text-neutral-300 ring-neutral-800 hover:bg-neutral-800/40'
                  }`}
                >
                  <span>{fw.label}</span>
                  <span
                    className={`rounded-md px-1 py-0 text-[10px] font-mono tabular-nums ${
                      isActive
                        ? 'bg-violet-500/25 text-violet-100'
                        : 'bg-neutral-800/80 text-neutral-400'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Per-control rows for the selected framework. */}
          {currentGroups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-800 bg-neutral-950/30 px-3 py-4 text-center text-[11.5px] text-neutral-500">
              No findings mapped to {populated.find((p) => p.key === currentFw)?.label} controls.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {currentGroups.map((g) => {
                const key = `${String(currentFw)}::${g.control}`;
                const expanded = expandedControls.has(key);
                const sev = SEVERITY_THEME[g.worst] ?? SEVERITY_THEME.info;
                return (
                  <li
                    key={key}
                    className="rounded-lg border border-neutral-800/60 bg-neutral-950/30"
                  >
                    <button
                      type="button"
                      onClick={() => toggleControl(key)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-900/40"
                    >
                      <ChevronRight
                        className={`h-3 w-3 flex-shrink-0 text-neutral-600 transition-transform ${expanded ? 'rotate-90 text-neutral-300' : ''}`}
                        strokeWidth={2.5}
                      />
                      <span className="font-mono text-[12px] font-medium text-neutral-200">
                        {g.control}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${sev.iconBg} ${sev.iconColor}`}
                        title={`Worst severity in this control: ${sev.label}`}
                      >
                        {sev.label}
                      </span>
                      <span className="ml-auto font-mono text-[10.5px] tabular-nums text-neutral-500">
                        {g.findings.length} finding{g.findings.length === 1 ? '' : 's'}
                      </span>
                    </button>

                    {expanded && (
                      <ul className="space-y-1 border-t border-neutral-800/40 px-3 py-2">
                        {g.findings.map((f) => {
                          const fsev = SEVERITY_THEME[f.severity as keyof typeof SEVERITY_THEME]
                            ?? SEVERITY_THEME.info;
                          return (
                            <li key={f.id}>
                              <a
                                href={`#finding-${f.id}`}
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] transition-colors hover:bg-neutral-900/60"
                              >
                                <span
                                  className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${fsev.iconBg}`}
                                  title={fsev.label}
                                />
                                <span className="min-w-0 flex-1 truncate text-neutral-300">
                                  {f.title ?? '(untitled)'}
                                </span>
                                {(f.endpoint || f.target) && (
                                  <span className="hidden font-mono text-[10.5px] text-neutral-500 sm:inline">
                                    {f.endpoint ?? f.target}
                                  </span>
                                )}
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <p className="flex items-start gap-2 rounded-md border border-neutral-800/60 bg-neutral-950/40 px-3 py-2 text-[10.5px] leading-relaxed text-neutral-500">
            {totalFindings > 0 ? (
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400/80" strokeWidth={2.5} />
            ) : (
              <ShieldCheck className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-400/80" strokeWidth={2.5} />
            )}
            <span>
              Mappings come from each finding&apos;s engine-emitted{' '}
              <span className="font-mono text-neutral-400">compliance_controls</span> field
              (engine PR #103). Click a control to see the matching findings; click a finding row
              to jump to its casefile.
            </span>
          </p>
        </div>
      )}
    </section>
  );
}
