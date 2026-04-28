import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';
import { getAllPosts } from './(marketing)/blog/posts';

// Returned by GET /sitemap.xml. Next derives the XML document from this
// array. Update whenever a new public marketing page lands.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  // Static marketing routes. The `priority` is informational — Google has
  // said for years that they ignore it, but other crawlers still read it,
  // and it documents importance for human readers of the file.
  const staticPages: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
    priority: number;
  }> = [
    { path: '/', changeFrequency: 'weekly', priority: 1.0 },
    { path: '/pricing', changeFrequency: 'weekly', priority: 0.9 },
    { path: '/about', changeFrequency: 'monthly', priority: 0.7 },
    { path: '/security', changeFrequency: 'monthly', priority: 0.8 },
    { path: '/security/disclosure', changeFrequency: 'yearly', priority: 0.5 },
    { path: '/contact', changeFrequency: 'yearly', priority: 0.5 },
    { path: '/blog', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/changelog', changeFrequency: 'weekly', priority: 0.7 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
    { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
  ];

  // Blog posts — pulled from the static registry. When this becomes a CMS,
  // swap the source; the sitemap shape stays.
  const posts = getAllPosts().map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}`,
    lastModified: new Date(post.date),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  return [
    ...staticPages.map((p) => ({
      url: `${SITE_URL}${p.path}`,
      lastModified: now,
      changeFrequency: p.changeFrequency,
      priority: p.priority,
    })),
    ...posts,
  ];
}
