import type { Metadata } from 'next';

// Single source of truth for the canonical site URL. Used by metadataBase,
// sitemap.ts, robots.ts, and per-page openGraph blocks. Falls back to the
// production hostname when the env isn't set, so a forgotten env var doesn't
// silently emit `localhost` URLs into og:url tags on a real deploy.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
  'https://youraisecurityengineer.com'
).replace(/\/$/, '');

export const SITE_NAME = 'your AI security engineer';

// Used as the description fallback on pages that don't override it.
export const DEFAULT_DESCRIPTION =
  'An AI security engineer that finds real vulnerabilities in your apps. Reinforcement-trained to eliminate false positives.';

interface PageSeoArgs {
  title: string;
  description: string;
  path: string; // Leading slash, no trailing slash. e.g. "/pricing".
  /** Override OG type. Defaults to "website". */
  type?: 'website' | 'article';
  /** Per-page OG image path or absolute URL. Falls back to the root /opengraph-image. */
  image?: string;
  /** Override the rendered <title>. By default the title above is suffixed with " — your AI security engineer" */
  rawTitle?: boolean;
  noIndex?: boolean;
}

/**
 * Builds a complete Metadata object for a marketing page in one call.
 * Centralises canonical URL handling, OG / Twitter card defaults, and the
 * site-wide title suffix so we don't repeat the same boilerplate on every
 * page (`/contact`, `/about`, `/pricing`, …).
 */
export function buildPageMetadata({
  title,
  description,
  path,
  type = 'website',
  image,
  rawTitle = false,
  noIndex = false,
}: PageSeoArgs): Metadata {
  const fullTitle = rawTitle ? title : `${title} — ${SITE_NAME}`;
  const url = `${SITE_URL}${path}`;
  const ogImage = image ?? '/opengraph-image';

  return {
    title: fullTitle,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: SITE_NAME,
      type,
      images: [{ url: ogImage }],
      locale: 'en_US',
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [ogImage],
    },
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
  };
}
