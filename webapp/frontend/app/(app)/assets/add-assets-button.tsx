'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Plus,
  Plug,
  Pencil,
  Upload,
  X,
  ArrowRight,
  GitBranch,
  Cloud,
  Globe,
  Container,
  Network,
  Server,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// "+ Add assets" button + sheet. Replaces the four peer-level
// "Templates · CSV · Terraform · GitHub · Add" buttons that were
// crammed into the page header. Three clear paths, ranked by which
// works for most users:
//
//   1. Connect a system  → integration → auto-discovery (the 80% case)
//   2. Add one manually   → single-asset form (the 15%)
//   3. Bulk import        → CSV / Terraform / API (the 5%, but they
//                            love it when it's there)

interface Path {
  Icon: LucideIcon;
  badge: string;
  title: string;
  blurb: string;
  cta: string;
  href: string;
  secondary?: { label: string; href: string }[];
}

const PATHS: Path[] = [
  {
    Icon: Plug,
    badge: 'recommended',
    title: 'Connect a system',
    blurb:
      'Wire up GitHub / AWS / GCP / Azure / Kubernetes / a domain — we discover assets for you and propose them in one bulk-approve flow.',
    cta: 'Pick an integration',
    href: '/integrations',
    secondary: [
      { label: 'GitHub', href: '/integrations/new/github' },
      { label: 'AWS', href: '/integrations/new/aws' },
      { label: 'GCP', href: '/integrations/new/gcp' },
      { label: 'Azure', href: '/integrations/new/azure' },
      { label: 'Kubernetes', href: '/integrations/new/k8s' },
      { label: 'Apex domain', href: '/integrations/new/domain' },
    ],
  },
  {
    Icon: Pencil,
    badge: '',
    title: 'Add one manually',
    blurb:
      'Paste a URL, container image, repo, or cloud account ID. Useful when the asset isn\'t in a connected system.',
    cta: 'Open the form',
    href: '/assets/new',
  },
  {
    Icon: Upload,
    badge: '',
    title: 'Bulk import',
    blurb:
      'CSV from your CMDB, Terraform state file, or the public JSON API. Idempotent re-imports via stable external_id.',
    cta: 'Choose a format',
    href: '/assets/import-csv',
    secondary: [
      { label: 'CSV upload', href: '/assets/import-csv' },
      { label: 'Terraform state', href: '/assets/import-terraform' },
      { label: 'GitHub repos', href: '/assets/import-github' },
    ],
  },
];

const SURFACES: { Icon: LucideIcon; label: string }[] = [
  { Icon: GitBranch, label: 'repos' },
  { Icon: Globe, label: 'web apps' },
  { Icon: Cloud, label: 'cloud accounts' },
  { Icon: Container, label: 'containers' },
  { Icon: Network, label: 'domains' },
  { Icon: Server, label: 'APIs / IPs' },
];

export default function AddAssetsButton() {
  const [open, setOpen] = useState(false);

  // Esc to close — keyboard-first interaction matters for power users.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-sm shadow-white/10 transition-all hover:-translate-y-0.5 hover:shadow-md hover:shadow-white/15"
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        Add assets
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-12 w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl shadow-black/50"
          >
            <header className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">
                  Where are your assets?
                </h2>
                <p className="mt-1 text-sm text-neutral-400">
                  Pick a starting point. Most teams take 60 seconds for the
                  first one.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {/* What we'll discover — quick visual primer */}
            <div className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
              <p className="text-[11px] text-neutral-500">
                Whatever you connect, we cover:
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {SURFACES.map((s) => (
                  <span
                    key={s.label}
                    className="inline-flex items-center gap-1 rounded bg-neutral-800/70 px-1.5 py-0.5 text-[10.5px] text-neutral-300"
                  >
                    <s.Icon className="h-3 w-3 text-cyan-300" strokeWidth={2.5} />
                    {s.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              {PATHS.map((p) => (
                <PathCard key={p.title} path={p} onClose={() => setOpen(false)} />
              ))}
            </div>

            <p className="mt-5 text-[11px] text-neutral-500">
              Need shared scan config across many assets?{' '}
              <Link
                href="/setup"
                className="text-cyan-300 hover:underline"
                onClick={() => setOpen(false)}
              >
                Asset templates live in Setup
              </Link>
              .
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function PathCard({ path, onClose }: { path: Path; onClose: () => void }) {
  return (
    <div className="group rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-colors hover:border-cyan-500/40 hover:bg-neutral-900/50">
      <Link
        href={path.href}
        onClick={onClose}
        className="flex items-start gap-3"
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-200 ring-1 ring-inset ring-white/5">
          <path.Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">
              {path.title}
            </span>
            {path.badge && (
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-500/30">
                {path.badge}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
            {path.blurb}
          </p>
        </div>
        <ArrowRight
          className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-neutral-500 transition-all group-hover:translate-x-1 group-hover:text-cyan-300"
          strokeWidth={2.25}
        />
      </Link>
      {path.secondary && (
        <div className="ml-12 mt-3 flex flex-wrap gap-1.5">
          {path.secondary.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              onClick={onClose}
              className="rounded-md border border-neutral-700 bg-neutral-900/40 px-2 py-0.5 text-[10.5px] text-neutral-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
            >
              {s.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
