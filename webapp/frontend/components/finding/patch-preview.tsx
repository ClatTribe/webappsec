'use client';

import { useState } from 'react';
import {
  Wrench,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  GitPullRequest,
  ExternalLink,
  Loader2,
} from 'lucide-react';

// PatchPreview — engine PRs #243 + #250 (Patcher specialist) / migration 058.
//
// Inline diff renderer for a single finding's suggested patch. Collapsed
// by default — clicking the "Suggested fix" button expands a syntax-
// colored unified-diff view with a Copy-to-clipboard action.
//
// We deliberately don't try to deep-parse the diff (split hunks, render
// gutter line numbers, render side-by-side). Real-world strix patches
// are 5-40 lines of plain unified diff and a flat per-line render with
// line-prefix coloring is enough to scan at a glance. Apply-as-PR flow
// is a follow-up that hooks into the existing GitHub OAuth integration.

export interface PatchSignals {
  patch_id: string | null;
  patch_diff: string | null;
  patch_commit_message: string | null;
  patch_status: string | null;            // 'proposed' | 'applied' | 'verified' | 'failed'
  patch_verified_at: string | null;
  patch_proposed_at: string | null;
  patch_pr_url: string | null;
  patch_applied_at: string | null;
}

export default function PatchPreview({
  findingId,
  patch,
}: {
  findingId: string;
  patch: PatchSignals;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Apply-as-PR state. We track the PR URL locally so a successful
  // apply renders the "View PR" link immediately without needing a
  // page refresh. On revisit the server-side patch_pr_url takes over.
  const [applying, setApplying] = useState(false);
  const [appliedPrUrl, setAppliedPrUrl] = useState<string | null>(
    patch.patch_pr_url ?? null,
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyHint, setApplyHint] = useState<string | null>(null);

  async function applyAsPr() {
    if (applying || appliedPrUrl) return;
    setApplying(true);
    setApplyError(null);
    setApplyHint(null);
    try {
      const res = await fetch(`/api/findings/${findingId}/apply-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApplyError(
          body.error === 'no_github_integration'
            ? 'Connect a GitHub account first.'
            : (body.error ?? `Apply failed (HTTP ${res.status}).`),
        );
        setApplyHint(typeof body.hint === 'string' ? body.hint : null);
        return;
      }
      if (typeof body.pr_url === 'string') {
        setAppliedPrUrl(body.pr_url);
      }
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  if (!patch.patch_diff) return null;

  const status = (patch.patch_status ?? 'proposed').toLowerCase();
  const isVerified = status === 'verified' || !!patch.patch_verified_at;
  const isFailed = status === 'failed';

  async function copy() {
    if (!patch.patch_diff) return;
    try {
      await navigator.clipboard.writeText(patch.patch_diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (insecure context, denied permission);
      // silently no-op — the diff is still selectable in the DOM.
    }
  }

  return (
    <div
      className={`mt-3 rounded-xl border ${
        isVerified
          ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
          : isFailed
            ? 'border-amber-500/30 bg-amber-500/[0.04]'
            : 'border-violet-500/30 bg-violet-500/[0.04]'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <Wrench
          className={`h-3.5 w-3.5 flex-shrink-0 ${
            isVerified ? 'text-emerald-300' : isFailed ? 'text-amber-300' : 'text-violet-300'
          }`}
          strokeWidth={2.25}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[12.5px] font-semibold text-neutral-100">Suggested fix</span>
            <StatusBadge status={status} verifiedAt={patch.patch_verified_at} />
            {patch.patch_id && (
              <span className="font-mono text-[10.5px] text-neutral-500">
                {patch.patch_id}
              </span>
            )}
          </div>
          {patch.patch_commit_message && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-400">
              {patch.patch_commit_message}
            </div>
          )}
        </div>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" strokeWidth={2.25} />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" strokeWidth={2.25} />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-neutral-800/60 px-3.5 py-3">
          <div className="flex items-center justify-between gap-2 text-[10.5px] text-neutral-500">
            <span title="Engine's Patcher specialist proposed this unified diff (strix PRs #243/#250).">
              Unified diff from strix Patcher — review before applying
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-neutral-300 ring-1 ring-neutral-700 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" strokeWidth={2.5} />
                    Copy
                  </>
                )}
              </button>
              {appliedPrUrl ? (
                <a
                  href={appliedPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/40 transition-colors hover:bg-emerald-500/10"
                >
                  <GitPullRequest className="h-3 w-3" strokeWidth={2.5} />
                  View PR
                  <ExternalLink className="h-2.5 w-2.5" strokeWidth={2.5} />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={applyAsPr}
                  disabled={applying}
                  className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-200 ring-1 ring-violet-400/40 transition-colors hover:bg-violet-500/25 disabled:cursor-wait disabled:opacity-60"
                >
                  {applying ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
                      Opening PR…
                    </>
                  ) : (
                    <>
                      <GitPullRequest className="h-3 w-3" strokeWidth={2.5} />
                      Apply as PR
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {applyError && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2.5} />
                <div className="space-y-1">
                  <div className="font-medium">{applyError}</div>
                  {applyHint && <div className="text-amber-200/80">{applyHint}</div>}
                </div>
              </div>
            </div>
          )}

          <DiffRenderer diff={patch.patch_diff} />
          {isFailed && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
              <AlertTriangle className="mr-1 inline h-3 w-3" strokeWidth={2.5} />
              Engine attempted to apply this patch and the verification probe still fired —
              the diff isn&apos;t a complete fix.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, verifiedAt }: { status: string; verifiedAt: string | null }) {
  if (status === 'verified' || verifiedAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/30">
        <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={3} />
        verified
      </span>
    );
  }
  if (status === 'applied') {
    return (
      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-200 ring-1 ring-blue-400/30">
        applied
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200 ring-1 ring-amber-400/30">
        failed
      </span>
    );
  }
  return (
    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-200 ring-1 ring-violet-400/30">
      proposed
    </span>
  );
}

function DiffRenderer({ diff }: { diff: string }) {
  // Cap at 200 lines for the inline view — long diffs (rare but
  // possible) get a "show full diff" footer pointing at the raw
  // content. Real-world strix patches are 5–40 lines.
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const truncated = lines.length > 200;
  const display = truncated ? lines.slice(0, 200) : lines;

  return (
    <pre className="overflow-x-auto rounded-lg border border-neutral-800/60 bg-neutral-950/80 text-[11px] leading-[1.6]">
      <code className="block">
        {display.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
        {truncated && (
          <div className="border-t border-neutral-800/60 px-3 py-1.5 text-neutral-500">
            … {lines.length - 200} more lines (full diff in patch_diff column)
          </div>
        )}
      </code>
    </pre>
  );
}

function DiffLine({ line }: { line: string }) {
  let tone = 'text-neutral-400';
  if (line.startsWith('+') && !line.startsWith('+++')) tone = 'bg-emerald-500/[0.06] text-emerald-200';
  else if (line.startsWith('-') && !line.startsWith('---')) tone = 'bg-red-500/[0.06] text-red-200';
  else if (line.startsWith('@@')) tone = 'text-violet-300 bg-violet-500/[0.05]';
  else if (line.startsWith('+++') || line.startsWith('---')) tone = 'text-neutral-300';
  else if (line.startsWith('diff ') || line.startsWith('index ')) tone = 'text-neutral-500';
  return <div className={`whitespace-pre px-3 ${tone}`}>{line || ' '}</div>;
}
