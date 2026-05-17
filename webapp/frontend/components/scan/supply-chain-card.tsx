'use client';

import { Shield, BadgeCheck, AlertOctagon, AlertTriangle, ExternalLink } from 'lucide-react';
import type { SupplyChainAttestation } from '@/lib/supabase/types';

// Wishlist §18.4 — Cosign signature + SLSA provenance card.
//
// Engine PR #286 runs `cosign verify` against the scanned image's
// sigstore signature (keyless via Fulcio when configured) AND extracts
// SLSA provenance from the image's referrers. Findings carry the
// `signature_status` + `slsa_level` + `builder_uri` triple on
// scans.run_meta.supply_chain.
//
// Renders as a top-of-scan-detail card for container_image scans —
// supply-chain integrity is a CISO-visible metric; one glance answers
// "do we trust this image's origin?"

interface Props {
  attestation: SupplyChainAttestation;
}

export default function SupplyChainCard({ attestation }: Props) {
  const sig = SIG_THEME[attestation.signature_status] ?? SIG_THEME.unknown;
  const slsa =
    attestation.slsa_level !== null && attestation.slsa_level !== undefined
      ? SLSA_THEME[attestation.slsa_level]
      : null;

  return (
    <section
      className={`overflow-hidden rounded-2xl border ${sig.borderCls} ${sig.bgCls}`}
    >
      <header className="flex items-start gap-3 px-5 py-4">
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ring-1 ${sig.iconBg}`}
        >
          <sig.Icon className={`h-5 w-5 ${sig.iconText}`} strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-300">
            Supply-chain attestation
          </h2>
          <p className="mt-0.5 text-[14px] font-semibold text-neutral-100">
            {sig.headline}
            {slsa && (
              <>
                {' '}
                <span className={`rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold uppercase tracking-wider ring-1 ${slsa.cls}`}>
                  SLSA {slsa.label}
                </span>
              </>
            )}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-400">
            {sig.detail}
            {slsa && ` ${slsa.detail}`}
          </p>
        </div>
      </header>

      {(attestation.signed_by || attestation.builder_uri) && (
        <div className="border-t border-current/10 bg-neutral-950/30 px-5 py-3 text-[11px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {attestation.signed_by && (
              <>
                <dt className="text-neutral-500">Signed by</dt>
                <dd className="break-all font-mono text-neutral-300">
                  {attestation.signed_by}
                </dd>
              </>
            )}
            {attestation.builder_uri && (
              <>
                <dt className="text-neutral-500">Builder</dt>
                <dd className="break-all">
                  <a
                    href={isUrl(attestation.builder_uri) ? attestation.builder_uri : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-baseline gap-1 font-mono text-neutral-300 underline-offset-2 hover:text-neutral-100 hover:underline"
                  >
                    {attestation.builder_uri}
                    {isUrl(attestation.builder_uri) && (
                      <ExternalLink className="h-2.5 w-2.5 opacity-60" strokeWidth={2.5} />
                    )}
                  </a>
                </dd>
              </>
            )}
            {attestation.signature_observed_at && (
              <>
                <dt className="text-neutral-500">Observed</dt>
                <dd className="text-neutral-400">
                  {new Date(attestation.signature_observed_at).toLocaleString()}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

const SIG_THEME: Record<
  SupplyChainAttestation['signature_status'],
  {
    headline: string;
    detail: string;
    Icon: typeof BadgeCheck;
    iconText: string;
    iconBg: string;
    borderCls: string;
    bgCls: string;
  }
> = {
  signed_by_trusted: {
    headline: 'Image is signed by a trusted issuer',
    detail:
      'Cosign verified the signature against Fulcio with a recognised issuer (GitHub Actions, GitLab, Buildkite, etc.). The image came from where it claims to come from.',
    Icon: BadgeCheck,
    iconText: 'text-emerald-300',
    iconBg: 'bg-emerald-500/15 ring-emerald-400/30',
    borderCls: 'border-emerald-500/30',
    bgCls: 'bg-gradient-to-b from-emerald-500/[0.04] to-emerald-500/[0.01]',
  },
  signed_unknown_issuer: {
    headline: 'Image is signed but issuer is unverified',
    detail:
      'Cosign found a signature, but the certificate issuer is not in your trusted-issuer list. Treat as informational — the signature exists but provenance is ambiguous.',
    Icon: AlertTriangle,
    iconText: 'text-amber-300',
    iconBg: 'bg-amber-500/15 ring-amber-400/30',
    borderCls: 'border-amber-500/30',
    bgCls: 'bg-gradient-to-b from-amber-500/[0.04] to-amber-500/[0.01]',
  },
  unsigned: {
    headline: 'Image is unsigned',
    detail:
      'No sigstore signature found. Supply-chain integrity is unverifiable for this image; the build pipeline should sign with Cosign (keyless via Fulcio is free + zero-config).',
    Icon: AlertOctagon,
    iconText: 'text-rose-300',
    iconBg: 'bg-rose-500/15 ring-rose-400/30',
    borderCls: 'border-rose-500/30',
    bgCls: 'bg-gradient-to-b from-rose-500/[0.04] to-rose-500/[0.01]',
  },
  unknown: {
    headline: 'Signature status unknown',
    detail:
      'The image registry does not expose signature metadata or the verification path failed transiently. Re-run the scan to retry.',
    Icon: Shield,
    iconText: 'text-neutral-400',
    iconBg: 'bg-neutral-800/80 ring-neutral-700',
    borderCls: 'border-neutral-700',
    bgCls: 'bg-neutral-900/30',
  },
};

const SLSA_THEME: Record<
  0 | 1 | 2 | 3,
  { label: string; cls: string; detail: string }
> = {
  0: {
    label: 'L0',
    cls: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    detail: 'No SLSA provenance attached — no proof of how this image was built.',
  },
  1: {
    label: 'L1',
    cls: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
    detail: 'Source identified, build is scripted. Basic provenance.',
  },
  2: {
    label: 'L2',
    cls: 'bg-cyan-500/15 text-cyan-200 ring-cyan-400/30',
    detail: 'Hermetic build on a hosted platform with provenance generation.',
  },
  3: {
    label: 'L3',
    cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30',
    detail: 'Isolated builder with non-falsifiable provenance — the strongest tier.',
  },
};
