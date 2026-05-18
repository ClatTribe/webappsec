import Link from 'next/link';
import { Cloud, ChevronRight, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const metadata = {
  title: 'Connect a cloud account',
};

// /integrations/new/cloud — three-way picker that fronts the existing
// AWS / GCP / Azure forms. The Home empty-state "Connect a cloud
// account" card points here. Symmetric with /integrations/new/github
// (single-cloud forms exist; this just picks among them) and
// /assets/new/web (focused entry point instead of a generic picker).
//
// The engine ships full CSPM coverage across all three clouds via
// Prowler — same set of checks against AWS / GCP / Azure. The
// wrapper has integration forms + asset discoverers + evidence
// collectors for each. This page is purely the cloud-pick step.

interface Provider {
  Icon: LucideIcon;
  label: string;
  blurb: string;
  href: string;
  badge?: string;
}

const PROVIDERS: Provider[] = [
  {
    Icon: Cloud,
    label: 'AWS',
    blurb:
      'IAM, S3 / EC2 / RDS posture, public assets, attack-path graph to your data. Connects via IAM role + STS AssumeRole (short-lived creds at scan time).',
    href: '/integrations/new/aws',
    badge: 'most common',
  },
  {
    Icon: Cloud,
    label: 'Google Cloud',
    blurb:
      'Project IAM, Cloud Run / Cloud Functions / App Engine, public storage, service-account hygiene. Connects via a service-account JSON key.',
    href: '/integrations/new/gcp',
  },
  {
    Icon: Cloud,
    label: 'Microsoft Azure',
    blurb:
      'Subscription posture, App Service / Function Apps, public IPs with DNS, Front Door endpoints. Connects via a service principal (client_id + secret + tenant).',
    href: '/integrations/new/azure',
  },
];

export default function CloudPickerPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link
          href="/integrations"
          className="transition-colors hover:text-neutral-300"
        >
          Integrations
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Connect a cloud account</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-blue-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">
            Connect a cloud account
          </h1>
        </div>
        <p className="max-w-xl text-sm text-neutral-400">
          Same set of checks across all three — IAM sprawl, public assets,
          attack chains into your data, drift between deployed and declared.
          Pick the cloud you want to start with.
        </p>
      </header>

      <section className="space-y-3">
        {PROVIDERS.map((p) => (
          <Link
            key={p.label}
            href={p.href}
            className="group flex items-start gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/30 p-5 transition-all hover:-translate-y-0.5 hover:border-cyan-500/40 hover:bg-neutral-900/50"
          >
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-cyan-500/20 text-blue-200 ring-1 ring-inset ring-white/5">
              <p.Icon className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-white">
                  {p.label}
                </span>
                {p.badge && (
                  <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-500/30">
                    {p.badge}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-neutral-400">{p.blurb}</p>
            </div>
            <ArrowRight
              className="mt-1 h-4 w-4 flex-shrink-0 text-neutral-500 transition-all group-hover:translate-x-1 group-hover:text-cyan-300"
              strokeWidth={2}
            />
          </Link>
        ))}
      </section>

      <p className="text-xs text-neutral-500">
        Connecting Kubernetes instead?{' '}
        <Link
          href="/integrations/new/k8s"
          className="text-cyan-300 hover:underline"
        >
          Kubeconfig form is here
        </Link>
        .
      </p>
    </div>
  );
}
