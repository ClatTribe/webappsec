import Link from 'next/link';
import { ShieldCheck, ArrowRight, Code2 as GithubIcon } from 'lucide-react';

const NAV_LINKS = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/blog', label: 'Blog' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/security', label: 'Security' },
  { href: '/about', label: 'About' },
];

export function MarketingNav() {
  return (
    <nav className="sticky top-0 z-30 border-b border-neutral-900/60 bg-neutral-950/60 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/30">
            <ShieldCheck className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <span className="text-base font-semibold tracking-tight">Strix</span>
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
            href="https://github.com/ClatTribe/webappsec"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:text-white sm:inline-flex"
          >
            <GithubIcon className="h-4 w-4" />
            GitHub
          </Link>
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
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-cyan-500 to-blue-600">
                <ShieldCheck className="h-4 w-4 text-white" strokeWidth={2.5} />
              </div>
              <span className="text-sm font-semibold">Strix</span>
            </Link>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-neutral-500">
              AI-powered application security for teams that don't have a red team. Built on the
              open-source{' '}
              <a
                href="https://github.com/usestrix/strix"
                target="_blank"
                rel="noreferrer"
                className="text-neutral-400 hover:text-white"
              >
                Strix agent
              </a>
              .
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
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-neutral-900/80 pt-6 sm:flex-row sm:items-center">
          <p className="text-[11px] text-neutral-600">
            © {new Date().getFullYear()} Strix. Open-source under Apache-2.0.
          </p>
          <a
            href="https://github.com/ClatTribe/webappsec"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-neutral-300"
          >
            <GithubIcon className="h-3 w-3" />
            ClatTribe/webappsec
          </a>
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
