'use client';

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Copy, Check } from 'lucide-react';
import type { MfaAttestation } from '@/lib/supabase/types';

// Engine PR #132 / wishlist §14.7 row 1 — MFA posture badge.
//
// The engine's `mfa_attestation_check` returns a 4-point score across:
//   - login_tokens          (login form posts to a bearer-issuing endpoint)
//   - challenge_keys        (challenge endpoints reveal MFA enforcement)
//   - webauthn_header       (WebAuthn / passkey signal in headers)
//   - mfa_setup_paths       (setup/recovery paths exist in the surface)
//
// Tied to the auditor's "show me MFA is enforced" question with a
// one-line attestation copy-paste. The score renders as a 0–4
// fraction with a colored band:
//   4    fully enforced     emerald
//   2-3  partial             amber
//   0-1  weak / missing      rose
//
// Each breakdown key renders as a chip — present (emerald) / absent
// (neutral). Unknown keys (future engine drift) render with their raw
// snake_case label.

const BREAKDOWN_LABELS: Record<string, string> = {
  login_tokens: 'login tokens',
  challenge_keys: 'challenge keys',
  webauthn_header: 'WebAuthn',
  mfa_setup_paths: 'setup paths',
};

function bandTheme(score: number, max: number) {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 1) {
    return {
      ring: 'ring-emerald-500/30',
      bg: 'bg-emerald-500/[0.06]',
      text: 'text-emerald-200',
      Icon: ShieldCheck,
      label: 'Fully enforced',
    };
  }
  if (ratio >= 0.5) {
    return {
      ring: 'ring-amber-500/30',
      bg: 'bg-amber-500/[0.06]',
      text: 'text-amber-200',
      Icon: ShieldAlert,
      label: 'Partial',
    };
  }
  return {
    ring: 'ring-rose-500/30',
    bg: 'bg-rose-500/[0.06]',
    text: 'text-rose-200',
    Icon: ShieldX,
    label: 'Weak',
  };
}

export default function MfaPostureBadge({ mfa }: { mfa: MfaAttestation }) {
  const [copied, setCopied] = useState(false);

  const score =
    typeof mfa.score === 'number' && Number.isFinite(mfa.score)
      ? Math.max(0, mfa.score)
      : null;
  const max =
    typeof mfa.max === 'number' && Number.isFinite(mfa.max) && mfa.max > 0
      ? mfa.max
      : 4;

  if (score === null) return null;

  const theme = bandTheme(score, max);
  const Icon = theme.Icon;
  const breakdown = mfa.breakdown ?? null;
  const breakdownKeys = breakdown ? Object.keys(breakdown) : [];

  const attestationLine =
    mfa.attestation_text
    ?? `MFA posture: ${score}/${max} (${theme.label.toLowerCase()}) — engine PR #132 attestation.`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(attestationLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API blocked (secure context required) — silently
      // ignore; the operator can manually select the attestation block.
    }
  };

  return (
    <section
      className={`rounded-2xl border border-neutral-800/60 ${theme.bg} ring-1 ${theme.ring} p-5`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ring-white/5 ${theme.bg}`}
        >
          <Icon className={`h-7 w-7 ${theme.text}`} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              MFA posture
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${theme.bg} ${theme.text} ring-1 ${theme.ring}`}
            >
              {theme.label}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-4xl font-semibold tabular-nums ${theme.text}`}>{score}</span>
            <span className="text-sm text-neutral-500">/ {max}</span>
          </div>
          {breakdownKeys.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {breakdownKeys.map((key) => {
                const present = Boolean(
                  (breakdown as Record<string, unknown>)[key],
                );
                const label = BREAKDOWN_LABELS[key] ?? key.replace(/_/g, ' ');
                return (
                  <span
                    key={key}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${
                      present
                        ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/20'
                        : 'bg-neutral-800/40 text-neutral-500 ring-neutral-700/40'
                    }`}
                  >
                    <span
                      className={`h-1 w-1 rounded-full ${
                        present ? 'bg-emerald-400' : 'bg-neutral-600'
                      }`}
                    />
                    {label}
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex items-start gap-2 pt-2">
            <div className="min-w-0 flex-1 rounded-lg border border-neutral-800/60 bg-neutral-950/30 p-2.5 text-[11.5px] leading-relaxed text-neutral-300">
              {attestationLine}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="flex-shrink-0 rounded-md border border-neutral-800/60 bg-neutral-950/30 p-1.5 text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
              title={copied ? 'Copied!' : 'Copy attestation line'}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-300" strokeWidth={2.5} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={2.25} />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
