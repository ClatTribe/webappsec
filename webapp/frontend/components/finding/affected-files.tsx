'use client';

import { FileCode, ExternalLink } from 'lucide-react';

// AffectedFiles — Phase A wrapper-side surface for the engine's
// `code_locations` (stored in `findings.affected_files`).
//
// Renders each location as a clickable pill that deep-links into the
// matching git host's blob view at the right line range. Supports
// GitHub, GitLab, and Bitbucket — the three hosts the wrapper's
// integration enum already covers. Falls through to a non-link pill
// for any other host (so a self-hosted GitLab still renders the
// metadata, just without the link).
//
// We deliberately don't query the target's `integration_id` to pick
// the host — the host is already inside the repo URL we already have
// on the join. The integration is only needed for cloning private
// repos (the worker's concern, not the renderer's).
//
// Per Architecture.md §1.1 we never re-derive what the engine emitted —
// `affected_files` carries `file`, `start_line`, `end_line`, `label`
// verbatim. We just frame them.

export interface CodeLocation {
  file?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  label?: string | null;
}

interface Props {
  affectedFiles: unknown;
  /** The repository URL from `targets.value`. Required for deeplinks;
   *  when null we render the file paths as plain text. */
  repoUrl: string | null;
  /** Branch / ref to link to. Defaults to "main" — the engine emits
   *  no canonical branch on findings today, and main is the right
   *  guess for >95% of public repos. */
  branch?: string | null;
}

export default function AffectedFiles({ affectedFiles, repoUrl, branch }: Props) {
  const locations = normalise(affectedFiles);
  if (locations.length === 0) return null;

  const host = repoUrl ? parseHost(repoUrl) : null;

  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300/80">
        Affected files
      </h4>
      <ul className="flex flex-wrap gap-1.5">
        {locations.map((loc, i) => {
          const url = host ? buildBlobUrl(host, loc, branch ?? 'main') : null;
          const label = formatLocation(loc);
          if (url) {
            return (
              <li key={`${loc.file}-${i}`}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/20 bg-cyan-500/[0.05] px-2 py-1 font-mono text-[11px] text-cyan-200 transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/10"
                  title={loc.label ?? `Open ${label} on ${host?.host}`}
                >
                  <FileCode className="h-3 w-3" strokeWidth={2.25} />
                  {label}
                  <ExternalLink className="h-2.5 w-2.5 opacity-70" strokeWidth={2.5} />
                </a>
              </li>
            );
          }
          return (
            <li
              key={`${loc.file}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/30 px-2 py-1 font-mono text-[11px] text-neutral-400"
              title={loc.label ?? undefined}
            >
              <FileCode className="h-3 w-3" strokeWidth={2.25} />
              {label}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function normalise(raw: unknown): CodeLocation[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeLocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const file = typeof obj.file === 'string' ? obj.file : null;
    if (!file) continue;
    out.push({
      file,
      start_line: typeof obj.start_line === 'number' ? obj.start_line : null,
      end_line: typeof obj.end_line === 'number' ? obj.end_line : null,
      label: typeof obj.label === 'string' ? obj.label : null,
    });
  }
  return out;
}

function formatLocation(loc: CodeLocation): string {
  if (!loc.start_line) return loc.file ?? 'unknown';
  if (loc.end_line && loc.end_line !== loc.start_line) {
    return `${loc.file}:${loc.start_line}-${loc.end_line}`;
  }
  return `${loc.file}:${loc.start_line}`;
}

interface ParsedHost {
  /** Canonical host name (github.com / gitlab.com / bitbucket.org / …) */
  host: string;
  /** Kind we use to pick the URL template */
  kind: 'github' | 'gitlab' | 'bitbucket' | 'unknown';
  owner: string;
  repo: string;
}

function parseHost(repoUrl: string): ParsedHost | null {
  const cleaned = repoUrl.trim();
  // https://github.com/<owner>/<repo>(.git)?(/)?
  const https = cleaned.match(/^https?:\/\/([^\/]+)\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/);
  if (https) {
    const host = https[1].toLowerCase();
    const kind = hostKind(host);
    return { host, kind, owner: https[2], repo: https[3] };
  }
  // git@github.com:<owner>/<repo>.git
  const ssh = cleaned.match(/^git@([^:]+):([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (ssh) {
    const host = ssh[1].toLowerCase();
    const kind = hostKind(host);
    return { host, kind, owner: ssh[2], repo: ssh[3] };
  }
  return null;
}

function hostKind(host: string): ParsedHost['kind'] {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  if (host === 'bitbucket.org' || host.startsWith('bitbucket.')) return 'bitbucket';
  return 'unknown';
}

function buildBlobUrl(parsed: ParsedHost, loc: CodeLocation, ref: string): string | null {
  if (!loc.file) return null;
  const path = encodeURI(loc.file.replace(/^\.?\//, ''));
  const start = loc.start_line;
  const end = loc.end_line;

  if (parsed.kind === 'github') {
    let frag = '';
    if (start) frag = end && end !== start ? `#L${start}-L${end}` : `#L${start}`;
    return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/blob/${encodeURIComponent(ref)}/${path}${frag}`;
  }
  if (parsed.kind === 'gitlab') {
    let frag = '';
    if (start) frag = end && end !== start ? `#L${start}-${end}` : `#L${start}`;
    return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/-/blob/${encodeURIComponent(ref)}/${path}${frag}`;
  }
  if (parsed.kind === 'bitbucket') {
    let frag = '';
    if (start) frag = end && end !== start ? `#lines-${start}:${end}` : `#lines-${start}`;
    return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/src/${encodeURIComponent(ref)}/${path}${frag}`;
  }
  return null;
}
