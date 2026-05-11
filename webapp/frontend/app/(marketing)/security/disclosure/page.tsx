import Link from 'next/link';
import { ChevronRight, Mail, ShieldAlert, Award, Clock, FileText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Responsible Disclosure',
  description:
    'How to report a security vulnerability in our service. We respond within 1 business day, fix critical issues within 7, and credit responsible reporters.',
  path: '/security/disclosure',
});

const TIMELINE: { Icon: LucideIcon; label: string; body: string }[] = [
  {
    Icon: Mail,
    label: 'Within 1 business day',
    body: 'We acknowledge receipt and assign a tracking ID.',
  },
  {
    Icon: Clock,
    label: 'Within 5 business days',
    body: 'We confirm or dispute the issue and share a remediation plan with target dates.',
  },
  {
    Icon: ShieldAlert,
    label: 'Within 7 days for critical, 30 for high',
    body: 'We ship the fix and let you know when it\'s deployed. Other severities follow on a best-effort schedule.',
  },
  {
    Icon: Award,
    label: 'After deployment',
    body: 'With your permission, we credit you in our security advisories and on this page.',
  },
];

export default function DisclosurePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/security" className="transition-colors hover:text-neutral-300">
          Security
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Responsible disclosure</span>
      </nav>

      <header className="mt-6 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          Responsible disclosure
        </p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
          Found a security issue?
        </h1>
        <p className="text-lg leading-relaxed text-neutral-300">
          We&apos;re a security tool — we&apos;d be embarrassed if our own product had a hole. If
          you&apos;ve found one, please tell us. We&apos;ll fix it fast, give you credit, and not
          threaten to sue.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-xl font-semibold text-white">How to report</h2>
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-200 ring-1 ring-inset ring-amber-500/40">
              <Mail className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-sm text-neutral-200">
                Email{' '}
                <a
                  href="mailto:security@tensorshield.ai"
                  className="font-semibold text-cyan-300 hover:underline"
                >
                  security@tensorshield.ai
                </a>{' '}
                with as much detail as you can: the affected endpoint or component, reproduction
                steps, the impact you&apos;ve observed, and (if you have one) a PoC.
              </p>
              <p className="mt-3 text-sm text-neutral-400">
                Encrypt sensitive details with our{' '}
                <a
                  href="/security/pgp-key.txt"
                  className="text-cyan-300 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  PGP key
                </a>{' '}
                (fingerprint <span className="font-mono">XXXX XXXX XXXX XXXX</span>) if you&apos;d
                prefer.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-xl font-semibold text-white">What you can expect from us</h2>
        <ol className="mt-6 space-y-3">
          {TIMELINE.map((step, i) => (
            <li
              key={step.label}
              className="flex items-start gap-4 rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
                <step.Icon className="h-4 w-4" strokeWidth={2.25} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-mono text-neutral-500">step {i + 1}</span>
                  <span className="text-sm font-semibold text-white">{step.label}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-neutral-300">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <ScopeCard
          title="In scope"
          color="emerald"
          items={[
            'app.tensorshield.ai (the hosted SaaS)',
            'API authentication, authorization, and tenant-isolation issues',
            'XSS / CSRF / SSRF in the application',
            'Improper credential storage or decryption-context leaks',
            'Sandbox-escape bugs in the worker',
            'Issues that cross the per-tenant model-isolation boundary',
          ]}
        />
        <ScopeCard
          title="Out of scope"
          color="rose"
          items={[
            'Reports from automated scanners with no exploitation context',
            'Missing security headers (we know — we have a CSP roadmap item)',
            'Self-XSS / social engineering of our users',
            'DoS / volumetric attacks',
            'Issues in third-party services (report to them; we\'ll help if it touches us)',
            'Best-practice deviations without a concrete impact path',
            'Vulnerabilities in dependencies that we don\'t actually use',
          ]}
        />
      </section>

      <section className="mt-12 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6">
        <h3 className="text-lg font-semibold text-white">Safe-harbor and rewards</h3>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-neutral-300">
          <p>
            <strong className="text-neutral-100">Safe harbor.</strong> We will not pursue legal
            action against researchers who, in good faith, follow this policy. Don't access more
            data than necessary to demonstrate the issue, don't degrade service, don't social-engineer
            our staff or users, and give us a reasonable window to fix before public disclosure.
            Stay within those lines and we'll thank you, not threaten you.
          </p>
          <p>
            <strong className="text-neutral-100">Recognition.</strong> With your permission, we
            list reporters in our security advisories.
          </p>
          <p>
            <strong className="text-neutral-100">Bounties.</strong> We don't run a formal bounty
            yet, but we send a thank-you and (where appropriate) a real-world reward — swag,
            credits, or for serious finds, cash. Report something interesting and you'll find out.
          </p>
        </div>
      </section>

      <section className="mt-12 rounded-2xl border border-neutral-800/80 bg-neutral-900/20 p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-neutral-300 ring-1 ring-inset ring-white/5">
            <FileText className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Machine-readable</h3>
            <p className="mt-1 text-sm text-neutral-400">
              We publish{' '}
              <a
                href="/.well-known/security.txt"
                className="text-cyan-300 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                /.well-known/security.txt
              </a>{' '}
              per RFC 9116. Crawlers and bug-bounty platforms can pick up the contact details from there.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function ScopeCard({
  title,
  color,
  items,
}: {
  title: string;
  color: 'emerald' | 'rose';
  items: string[];
}) {
  const dot = color === 'emerald' ? 'bg-emerald-400' : 'bg-rose-400';
  const accent = color === 'emerald' ? 'text-emerald-300' : 'text-rose-300';
  return (
    <div className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <h3 className={`text-sm font-semibold uppercase tracking-wider ${accent}`}>{title}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-2">
            <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
            <span className="text-sm leading-relaxed text-neutral-300">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
