import { SITE_NAME, SITE_URL } from '@/lib/seo';
import { getAllPosts } from '../posts';

// RSS 2.0 feed. Two consumers in mind:
//   1. Reader subscriptions (Feedly, Inoreader, NetNewsWire) — long-term
//      retention of readers who don't want to come back to /blog manually.
//   2. The changelog page already links to this URL via an <a href="/blog/rss.xml">
//      Rss button — without this route the link 404'd.
//
// Plain string-build instead of a feed library: two posts and predictable
// fields, no need for an extra dep.

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const posts = getAllPosts();

  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.slug}`;
      const pubDate = new Date(post.date).toUTCString();
      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(post.excerpt)}</description>
      ${post.tags.map((t) => `<category>${escapeXml(t)}</category>`).join('\n      ')}
      <author>noreply@youraisecurityengineer.com (${escapeXml(post.author.name)})</author>
    </item>`;
    })
    .join('\n');

  const lastBuildDate = posts.length
    ? new Date(posts[0].date).toUTCString()
    : new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SITE_NAME)} — Blog</title>
    <link>${SITE_URL}/blog</link>
    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml" />
    <description>Notes from the team. Engineering, product, application-security writing.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600',
    },
  });
}
