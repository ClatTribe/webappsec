import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

const NAV_LINKS = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Blog' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/security', label: 'Security' },
  { href: '/about', label: 'About' },
];

export function BrandMark({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'h-9 w-9 text-base' : 'h-8 w-8 text-sm';
  return (
    <span
      className={`flex flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 font-mono font-semibold text-white shadow-lg shadow-cyan-500/30 ${dim}`}
      aria-hidden
    >
      y.
    </span>
  );
}

export function BrandLockup({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <BrandMark />
      <span className="text-base font-semibold tracking-tight">
        your <span className="text-cyan-300">AI</span> security engineer
      </span>
    </span>
  );
}

export function MarketingNav() {
  return (
    <nav className="sticky top-0 z-30 border-b border-neutral-900/60 bg-neutral-950/60 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="block">
          <BrandLockup />
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-md px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:text-white"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-3.5 py-1.5 text-sm font-medium text-neutral-950 shadow-sm shadow-white/15 transition-all hover:shadow-md"
          >
            Get started
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </Link>
        </div>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-neutral-900/60 bg-neutral-950/40">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Link href="/" className="block">
              <span className="flex items-center gap-2">
                <BrandMark />
                <span className="text-sm font-semibold">your AI security engineer</span>
              </span>
            </Link>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-neutral-500">
              An AI security engineer that finds real vulnerabilities and learns from your triage to
              eliminate false positives over time.
            </p>
          </div>
          <FooterColumn
            title="Product"
            links={[
              { href: '/pricing', label: 'Pricing' },
              { href: '/changelog', label: 'Changelog' },
              { href: '/security', label: 'Security' },
              { href: '/signup', label: 'Get started' },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { href: '/about', label: 'About' },
              { href: '/blog', label: 'Blog' },
              { href: '/contact', label: 'Contact' },
            ]}
          />
          <FooterColumn
            title="Legal"
            links={[
              { href: '/privacy', label: 'Privacy' },
              { href: '/terms', label: 'Terms' },
              { href: '/security/disclosure', label: 'Disclosure policy' },
            ]}
          />
        </div>
        <div className="mt-10 border-t border-neutral-900/80 pt-6">
          <p className="text-[11px] text-neutral-600">
            © {new Date().getFullYear()} youraisecurityengineer. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
        {title}
      </h3>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="text-xs text-neutral-300 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketingBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 opacity-90"
      style={{
        background:
          'radial-gradient(60% 50% at 80% 0%, rgba(6, 182, 212, 0.15) 0%, transparent 60%), radial-gradient(50% 60% at 0% 30%, rgba(139, 92, 246, 0.12) 0%, transparent 60%), radial-gradient(80% 80% at 50% 100%, rgba(56, 189, 248, 0.05) 0%, transparent 70%)',
      }}
    />
  );
}
