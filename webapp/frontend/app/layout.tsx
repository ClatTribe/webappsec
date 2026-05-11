import './globals.css';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION } from '@/lib/seo';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

// metadataBase MUST be set so every per-page openGraph URL resolves to an
// absolute URL — without it, og:image and og:url are emitted as relative
// paths and crawlers (Slack unfurl, Twitter card validator, Search Console)
// silently drop them.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s — ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'AI security engineer',
    'TensorShield',
    'security for vibe-coded apps',
    'application security',
    'continuous security monitoring',
    'penetration testing automation',
    'closed-loop suppression',
    'false positive reduction',
    'SOC 2 evidence automation',
    'security compliance posture',
    'trust page',
    'agentic security',
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
  },
  // No favicon assets are tracked yet; once real artwork lands, drop the
  // files into app/icon.* / app/apple-icon.* and Next picks them up
  // automatically via convention.
};

// Organization + WebSite JSON-LD. Search engines use these to build the
// brand panel + sitelinks search box. Emitted from the root layout so
// every page contributes the same structured data and the schemas merge
// cleanly across crawls.
const ORGANIZATION_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: SITE_URL,
  description: DEFAULT_DESCRIPTION,
  // logo: `${SITE_URL}/logo.png`,  // add once we have a hosted brand asset
};

const WEBSITE_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  url: SITE_URL,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans text-neutral-100 antialiased selection:bg-cyan-500/30">
        {/* JSON-LD lives in the rendered HTML so it survives JS-disabled crawls. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_LD) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_LD) }}
        />
        {children}
      </body>
    </html>
  );
}
