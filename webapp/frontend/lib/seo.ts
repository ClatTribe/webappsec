import type { Metadata } from 'next';

// Single source of truth for the canonical site URL. Used by metadataBase,
// sitemap.ts, robots.ts, and per-page openGraph blocks. Falls back to the
// production hostname when the env isn't set, so a forgotten env var doesn't
// silently emit `localhost` URLs into og:url tags on a real deploy.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
  'https://tensorshield.ai'
).replace(/\/$/, '');

export const SITE_NAME = 'TensorShield';

// Used as the description fallback on pages that don't override it.
export const DEFAULT_DESCRIPTION =
  'TensorShield is the AI security engineer for your vibe-coded apps. It scans your code, watches your URLs, and remembers every decision you make — so the same false positive never lands twice.';

interface PageSeoArgs {
  /** The bare page title — no site suffix. The root layout's title template
   *  appends " — {SITE_NAME}" automatically. Pass `rawTitle: true` to opt
   *  out of the template (used by the landing page, where the title is
   *  already the full marketing headline). */
  title: string;
  description: string;
  path: string; // Leading slash, no trailing slash. e.g. "/pricing".
  /** Override OG type. Defaults to "website". */
  type?: 'website' | 'article';
  /** Per-page OG image path or absolute URL. Falls back to the root /opengraph-image. */
  image?: string;
  /** Skip the root layout's title template — render `title` as the literal
   *  document title with no suffix. */
  rawTitle?: boolean;
  noIndex?: boolean;
}

/**
 * Builds a complete Metadata object for a marketing page in one call.
 * Centralises canonical URL handling, OG / Twitter card defaults, and the
 * site-wide title suffix so we don't repeat the same boilerplate on every
 * page (`/contact`, `/about`, `/pricing`, …).
 *
 * Title handling: the root layout sets a title template (`%s — {SITE_NAME}`).
 * We pass the bare title here and let the template add the suffix once. To
 * opt out (landing page), use `title: { absolute: ... }` via `rawTitle: true`.
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
  // For openGraph + twitter we want the *full* title (with the brand suffix)
  // because those tags are shown in isolation in unfurls. The HTML <title>
  // element gets the bare title and the root template fills in the suffix.
  const fullTitle = rawTitle ? title : `${title} — ${SITE_NAME}`;
  const url = `${SITE_URL}${path}`;
  const ogImage = image ?? '/opengraph-image';

  return {
    title: rawTitle ? { absolute: title } : title,
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
