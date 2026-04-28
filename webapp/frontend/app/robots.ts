import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';

// Public routes are indexable; everything behind auth is not. We list every
// authenticated route prefix explicitly rather than using a single `/`
// disallow so a forgotten route doesn't accidentally fall under it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/dashboard/',
          '/scans',
          '/scans/',
          '/findings',
          '/findings/',
          '/targets',
          '/targets/',
          '/integrations',
          '/integrations/',
          '/team',
          '/team/',
          '/settings',
          '/settings/',
          '/onboarding',
          '/onboarding/',
          '/login',
          '/signup',
          '/auth/',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
