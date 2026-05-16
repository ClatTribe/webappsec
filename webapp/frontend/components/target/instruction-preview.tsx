'use client';

import { Sparkles } from 'lucide-react';
import type { TargetType } from '@/lib/target-config';

interface Props {
  /** The user's free-text "what should the agent focus on" string. */
  userInstruction: string;
  /** Resolved target type — drives which augmenter rules apply. */
  type: TargetType;
  /** The same `config` shape the API consumes. Build via `buildConfigForType`. */
  config: Record<string, unknown>;
}

/**
 * Mirror of `webapp/worker/src/strix_worker/instruction.build_instruction`,
 * rendered live in the target form. The user sees exactly what the AI agent
 * will receive — making the §9.1 augmenter visible. If we change the Python
 * augmenter without updating this, the preview drifts; that's intentional
 * pressure to keep the contract honest.
 */
export default function InstructionPreview({ userInstruction, type, config }: Props) {
  const lines = augmentLines(type, config);
  const userText = userInstruction.trim();

  if (!userText && lines.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 p-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          <Sparkles className="h-3 w-3" strokeWidth={2.25} />
          Scan brief preview
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-500">
          Once you fill the fields above, the AI agent's brief will appear here. Empty fields are
          omitted — no placeholder noise reaches the model.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-cyan-300/80">
        <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        Scan brief preview
      </div>
      <p className="mt-1 text-[10.5px] text-neutral-500">
        This is exactly the text the AI agent will receive when the scan starts.
      </p>
      <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/80 p-3 font-mono text-[12px] leading-relaxed text-neutral-200">
        {userText && <div className="whitespace-pre-wrap">{userText}</div>}
        {lines.length > 0 && (
          <>
            {userText && <div className="my-2 h-px bg-neutral-800" />}
            <div className="text-neutral-300">Additional configuration for this target:</div>
            <ul className="mt-1 space-y-0.5">
              {lines.map((line, i) => (
                <li key={i}>
                  <span className="text-neutral-500">- </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-type augmenter — mirrors webapp/worker/src/strix_worker/instruction.py
// ---------------------------------------------------------------------------

function augmentLines(type: TargetType, config: Record<string, unknown>): string[] {
  if (!config) return [];
  switch (type) {
    case 'repository':
      return augmentRepository(config);
    case 'web_application':
      return augmentWebApplication(config);
    case 'api':
      return augmentApi(config);
    case 'container_image':
      return augmentContainerImage(config);
    case 'domain':
      return augmentDomain(config);
    case 'ip_address':
      return augmentIpAddress(config);
    case 'local_code':
      return augmentLocalCode(config);
  }
}

function asNonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function augmentRepository(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const branch = asNonEmptyStr(c.branch);
  if (branch) out.push(`Use the \`${branch}\` branch.`);
  const sub = asNonEmptyStr(c.subdirectory);
  if (sub) out.push(`Focus the analysis on the \`${sub}\` subdirectory only.`);
  return out;
}

function augmentWebApplication(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seeds = asStringList(c.crawl_seeds);
  if (seeds.length) out.push(`Begin crawling from these URLs: ${seeds.join(', ')}.`);
  const qps = c.rate_limit_qps;
  if (typeof qps === 'number' && Number.isInteger(qps) && qps > 0) {
    out.push(
      `Do not exceed ${qps} requests per second total — this is production traffic, treat it accordingly.`,
    );
  }
  return out;
}

function augmentApi(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const spec = asNonEmptyStr(c.spec_url);
  if (spec) {
    out.push(
      `Ingest the OpenAPI / Swagger spec at \`${spec}\` before probing — it's the endpoint inventory source.`,
    );
  }
  const qps = c.rate_limit_qps;
  if (typeof qps === 'number' && Number.isInteger(qps) && qps > 0) {
    out.push(
      `Do not exceed ${qps} requests per second total — this is production traffic, treat it accordingly.`,
    );
  }
  return out;
}

function augmentContainerImage(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const floor = asNonEmptyStr(c.severity_floor);
  if (floor) {
    out.push(
      `When invoking scan_container_image, pass severity_floor=\`${floor}\` to Trivy so the inbox doesn't drown in LOW noise.`,
    );
  }
  if (c.private_registry === true) {
    out.push(
      'This image lives in a private registry — the worker must have credentials configured (per-org auth is on the roadmap; v1 relies on the worker host\'s docker config).',
    );
  }
  return out;
}

function augmentDomain(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ex = asStringList(c.subdomain_excludes);
  if (ex.length) out.push(`Skip subdomains matching any of these patterns: ${ex.join(', ')}.`);
  return out;
}

function augmentIpAddress(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ports = asNonEmptyStr(c.port_spec);
  if (ports) out.push(`Scan only these ports: ${ports}.`);
  const proto = c.protocols;
  if (proto === 'both') out.push('Scan both TCP and UDP services.');
  else if (proto === 'tcp' || proto === 'udp') out.push(`Limit scanning to ${String(proto).toUpperCase()} services.`);
  return out;
}

function augmentLocalCode(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ex = asStringList(c.path_excludes);
  if (ex.length) out.push(`Ignore these paths: ${ex.join(', ')}.`);
  const hints = asStringList(c.language_hints);
  if (hints.length)
    out.push(`This codebase is primarily ${hints.join(', ')}; prime your static analysis accordingly.`);
  return out;
}
