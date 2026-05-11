'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Copy, Check, GitBranch, AlertCircle, Workflow } from 'lucide-react';
import type { ScanMode } from '@/lib/supabase/types';

// /scans/ci-snippet — CI/CD snippet generator (engine PR #121 / wishlist §13.3 row 3).
//
// Operators that want strix in their pipeline (e.g. "scan every PR", "nightly
// recon") can copy-paste a ready-to-use snippet. The wrapper does NOT run
// these scans — the engine does, directly from the customer's CI runner —
// but having the wrapper ship the canonical snippet means we own the
// "how do I integrate strix into CI?" UX.
//
// Snippets are templated against the operator's choices:
//   - Platform: GitHub Actions or GitLab CI
//   - Scan mode: quick / standard / deep
//   - Target: free-text URL / domain / repo
//   - Trigger: PR-only or also scheduled
//
// All `--quiet` (engine PR #121) and CI-friendly flags are pre-set so the
// pipeline output is parseable. The LLM key flows in via a CI secret —
// not a wrapper-managed secret — because these scans bypass the wrapper.

type Platform = 'github' | 'gitlab';

export default function CiSnippetPage() {
  const [platform, setPlatform] = useState<Platform>('github');
  const [scanMode, setScanMode] = useState<ScanMode>('standard');
  const [target, setTarget] = useState('https://example.com');
  const [scheduled, setScheduled] = useState(false);
  const [copied, setCopied] = useState(false);

  const snippet =
    platform === 'github'
      ? githubActionsSnippet({ scanMode, target, scheduled })
      : gitlabCiSnippet({ scanMode, target, scheduled });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API blocked — operator can manually select the textarea
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/scans" className="transition-colors hover:text-neutral-300">
          Scans
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">CI / CD snippet</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">CI / CD snippet</h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          Generate a ready-to-use YAML snippet for running strix in your pipeline.
          The engine runs directly from your CI runner — these scans don&apos;t flow
          through this wrapper.
        </p>
      </header>

      <section className="space-y-4 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Platform
            </label>
            <div className="flex gap-1.5">
              <PlatformChip
                active={platform === 'github'}
                onClick={() => setPlatform('github')}
                Icon={Workflow}
                label="GitHub Actions"
              />
              <PlatformChip
                active={platform === 'gitlab'}
                onClick={() => setPlatform('gitlab')}
                Icon={GitBranch}
                label="GitLab CI"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
              Scan mode
            </label>
            <div className="flex gap-1.5">
              {(['quick', 'standard', 'deep'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setScanMode(m)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    scanMode === m
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                      : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            Target
          </label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="https://example.com"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-xs text-neutral-100 placeholder-neutral-600 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
          <p className="mt-1 text-[11px] text-neutral-500">
            URL, domain, repo URL, or IP. The snippet hard-codes this for now;
            parameterise it via a CI variable in your real workflow.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-2.5 transition-colors hover:border-neutral-700">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(e) => setScheduled(e.target.checked)}
            className="mt-0.5 accent-cyan-500"
          />
          <span className="text-sm leading-relaxed">
            <span className="font-medium text-neutral-200">Add a nightly schedule</span>
            <span className="ml-1 text-[11.5px] text-neutral-500">
              Adds a cron trigger at 03:00 UTC alongside the per-PR / per-MR run.
              Useful for catching drift on long-lived branches.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
            {platform === 'github' ? '.github/workflows/strix.yml' : '.gitlab-ci.yml'}
          </h2>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-800/60"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-300" strokeWidth={2.5} />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" strokeWidth={2.25} />
                Copy snippet
              </>
            )}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-[11.5px] leading-relaxed text-neutral-200">
{snippet}
        </pre>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-3">
          <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-amber-200/80">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" strokeWidth={2.5} />
            <div className="space-y-1.5">
              <p>
                <strong className="text-amber-100">Provide the LLM API key as a CI secret.</strong>{' '}
                Set <code className="rounded bg-amber-500/15 px-1 font-mono text-[10.5px] text-amber-100">LLM_API_KEY</code>
                {' '}in your{' '}
                {platform === 'github'
                  ? 'repository → Settings → Secrets and variables → Actions'
                  : 'project → Settings → CI/CD → Variables'}
                . Never commit it.
              </p>
              <p>
                These pipeline scans bypass the wrapper. They produce a JUnit-style
                exit code (0 = clean, 2 = findings, 1 = engine error) so the CI
                run fails when a finding lands. Findings are not synced back to
                this dashboard — use the wrapper UI for triage / cross-scan dedup
                / RAG / audit-grade artifacts.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PlatformChip({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof Workflow;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
          : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
      }`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      {label}
    </button>
  );
}

interface SnippetParams {
  scanMode: ScanMode;
  target: string;
  scheduled: boolean;
}

function githubActionsSnippet({ scanMode, target, scheduled }: SnippetParams): string {
  // We pin a tagged image rather than `:latest` so the workflow is
  // reproducible — wishlist §13.3 row 3 calls out CI-friendly defaults
  // and "always pull latest" is the opposite of that.
  const triggers = scheduled
    ? `on:
  pull_request:
  schedule:
    - cron: '0 3 * * *'  # nightly at 03:00 UTC`
    : `on:
  pull_request:`;

  return `# .github/workflows/strix.yml
# Generated by the strix wrapper — engine PR #121 (--quiet / CI mode).
name: strix-security-scan
${triggers}

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Run strix
        uses: docker://ghcr.io/clattribe/strix:stable
        env:
          # Provide LLM_API_KEY as a repo secret (Settings → Secrets).
          LLM_API_KEY: \${{ secrets.LLM_API_KEY }}
          STRIX_LLM: openai/gpt-5.4
        with:
          args: >
            -n
            --quiet
            -m ${scanMode}
            -t ${target}

      # Exit codes:
      #   0 → completed, no findings
      #   2 → completed, findings emitted (we treat as failure)
      #   1 → engine error (treated as failure too)
      # GitHub Actions surfaces non-zero as a failed step automatically.
`;
}

function gitlabCiSnippet({ scanMode, target, scheduled }: SnippetParams): string {
  const scheduledNote = scheduled
    ? `# This pipeline also runs nightly via a Pipeline Schedule:
#   Project → CI/CD → Schedules → New schedule → cron "0 3 * * *"`
    : '';

  return `# .gitlab-ci.yml
# Generated by the strix wrapper — engine PR #121 (--quiet / CI mode).
${scheduledNote}
strix-security-scan:
  stage: test
  image: ghcr.io/clattribe/strix:stable
  variables:
    STRIX_LLM: openai/gpt-5.4
    # Provide LLM_API_KEY as a masked CI/CD variable
    # (Settings → CI/CD → Variables).
  script:
    - strix -n --quiet -m ${scanMode} -t ${target}
  # Exit codes:
  #   0 → completed, no findings (job passes)
  #   2 → findings emitted (job fails — this is what you want for PRs)
  #   1 → engine error (job fails)
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
${scheduled ? '    - if: $CI_PIPELINE_SOURCE == "schedule"' : ''}
`;
}
