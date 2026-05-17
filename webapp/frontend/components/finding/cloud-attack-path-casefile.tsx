'use client';

import { useState } from 'react';
import {
  Cloud,
  ChevronRight,
  Server,
  Key,
  Globe,
  FileText,
  AlertOctagon,
  Shield,
  ChevronDown,
} from 'lucide-react';
import type { Finding } from '@/lib/supabase/types';
import {
  parseAttackPathCasefile,
  patternDisplayName,
  type AttackPathHop,
} from '@/lib/cloud-attack-path';

// Wishlist §17.2 / §17.4 — Wiz-style attack-path casefile.
//
// Renders the casefile shape extracted from a Finding row whose
// category is `cloud_attack_path`:
//
//   - Pattern banner (the cap_* identifier as a friendly title)
//   - Hop chain (left-to-right node sequence with role icons)
//   - MITRE technique chips
//   - Narrative paragraph
//   - Remediation accordion
//
// Designed to slot inline into the existing FindingCard expanded
// body — same visual language as the existing kill-chain section.

interface Props {
  finding: Finding;
}

export default function CloudAttackPathCasefile({ finding }: Props) {
  const casefile = parseAttackPathCasefile(finding);
  if (casefile.isEmpty) return null;

  const [remediationOpen, setRemediationOpen] = useState(true);

  return (
    <section className="space-y-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.03] p-4">
      <header className="flex items-start gap-2">
        <AlertOctagon className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" strokeWidth={2.25} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-rose-200">
            Cloud attack path · {patternDisplayName(casefile.patternId)}
          </h3>
          <p className="mt-0.5 text-[10.5px] text-rose-200/70">
            A toxic combination of cloud misconfigurations chains into an exploit path.
            Fixing any single link breaks the chain.
          </p>
        </div>
      </header>

      {/* Hop chain --------------------------------------------- */}
      {casefile.hops.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-200/70">
            Hop chain ({casefile.hops.length} {casefile.hops.length === 1 ? 'node' : 'nodes'})
          </div>
          <HopChain hops={casefile.hops} />
        </div>
      )}

      {/* MITRE techniques --------------------------------------- */}
      {casefile.mitreTechniques.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-200/70">
            MITRE
          </span>
          {casefile.mitreTechniques.map((t) => (
            <a
              key={t}
              href={mitreTechniqueUrl(t)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/25"
            >
              {t}
            </a>
          ))}
        </div>
      )}

      {/* Narrative ---------------------------------------------- */}
      {casefile.narrative && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-200/70">
            Narrative
          </div>
          <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-neutral-300">
            {casefile.narrative}
          </p>
        </div>
      )}

      {/* Evidence edges ----------------------------------------- */}
      {casefile.edges.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-rose-200/70">
            Evidence edges ({casefile.edges.length})
          </summary>
          <ul className="mt-1.5 space-y-1">
            {casefile.edges.map((e, i) => (
              <li key={i} className="flex items-center gap-1.5 font-mono text-[10.5px] text-neutral-400">
                <span className="truncate">{e.from}</span>
                <span className="rounded bg-rose-500/15 px-1 py-px text-[9.5px] text-rose-200">
                  {e.kind ?? '→'}
                </span>
                <span className="truncate">{e.to}</span>
                {e.evidence && (
                  <span className="text-[9.5px] text-neutral-500">({e.evidence})</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Remediation -------------------------------------------- */}
      {casefile.remediation && (
        <div className="space-y-1 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] p-2.5">
          <button
            type="button"
            onClick={() => setRemediationOpen((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-200">
              <Shield className="h-3 w-3" strokeWidth={2.5} />
              Remediation
            </span>
            {remediationOpen ? (
              <ChevronDown className="h-3 w-3 text-emerald-300/70" strokeWidth={2.5} />
            ) : (
              <ChevronRight className="h-3 w-3 text-emerald-300/70" strokeWidth={2.5} />
            )}
          </button>
          {remediationOpen && (
            <p className="whitespace-pre-wrap pt-1.5 text-[11.5px] leading-relaxed text-emerald-100/90">
              {casefile.remediation}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// =============== Hop chain renderer ===============================

function HopChain({ hops }: { hops: AttackPathHop[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {hops.map((hop, i) => (
        <li key={`${hop.key}-${i}`} className="flex items-center gap-1.5">
          <HopNode hop={hop} index={i} />
          {i < hops.length - 1 && (
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-rose-300/60" strokeWidth={2.5} />
          )}
        </li>
      ))}
    </ol>
  );
}

function HopNode({ hop, index }: { hop: AttackPathHop; index: number }) {
  const Icon = hopIcon(hop.node_type);
  return (
    <div
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10.5px]"
      title={hop.key}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-rose-500/20 text-[9px] font-bold text-rose-200">
        {index + 1}
      </span>
      <Icon className="h-3 w-3 flex-shrink-0 text-rose-200/80" strokeWidth={2.25} />
      <div className="min-w-0 leading-tight">
        <div className="truncate font-mono text-[10.5px] text-neutral-100">
          {hop.label ?? hop.key}
        </div>
        {hop.detail && (
          <div className="truncate text-[9.5px] text-rose-200/60">{hop.detail}</div>
        )}
      </div>
    </div>
  );
}

function hopIcon(nodeType?: string) {
  switch ((nodeType ?? '').toLowerCase()) {
    case 'identity':
    case 'role':
    case 'user':
      return Key;
    case 'policy':
      return FileText;
    case 'external_principal':
    case 'internet':
      return Globe;
    case 'resource':
    default:
      return Server;
  }
}

function mitreTechniqueUrl(id: string): string {
  // T1078.004 → https://attack.mitre.org/techniques/T1078/004/
  const m = id.match(/^T(\d{4})(?:\.(\d{3}))?$/i);
  if (!m) return `https://attack.mitre.org/`;
  return m[2]
    ? `https://attack.mitre.org/techniques/T${m[1]}/${m[2]}/`
    : `https://attack.mitre.org/techniques/T${m[1]}/`;
}

// Cloud icon also re-exported so the dashboard card next door can
// match the visual language without re-importing lucide directly.
export { Cloud as CloudIcon };
