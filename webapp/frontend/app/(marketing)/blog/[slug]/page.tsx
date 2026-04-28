import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, Calendar, Clock } from 'lucide-react';
import type { Metadata } from 'next';
import { buildPageMetadata, SITE_NAME, SITE_URL } from '@/lib/seo';
import { getAllPosts, getPostBySlug } from '../posts';

interface Props {
  params: { slug: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPostBySlug(params.slug);
  if (!post) return { title: 'Post not found', robots: { index: false, follow: false } };
  // Per-post OG image lives at app/(marketing)/blog/[slug]/opengraph-image.tsx
  // — Next colocates the convention file by route, so we just point at the
  // canonical post path and the framework picks up the dynamic image.
  return buildPageMetadata({
    title: post.title,
    description: post.excerpt,
    path: `/blog/${post.slug}`,
    type: 'article',
  });
}

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export default function BlogPostPage({ params }: Props) {
  const post = getPostBySlug(params.slug);
  if (!post) notFound();

  // Article schema. Helps Google promote the post into rich results
  // (with date, author, image). The shape is the minimum required by
  // schema.org/Article validator.
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    dateModified: post.date,
    author: {
      '@type': 'Organization',
      name: post.author.name,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${SITE_URL}/blog/${post.slug}`,
    },
    image: `${SITE_URL}/blog/${post.slug}/opengraph-image`,
    keywords: post.tags.join(', '),
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <Link
        href="/blog"
        className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to blog
      </Link>

      <header className="mt-6 space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {post.date}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {post.readingTime}
          </span>
          {post.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300"
            >
              {t}
            </span>
          ))}
        </div>
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
          {post.title}
        </h1>
        <p className="text-lg leading-relaxed text-neutral-300">{post.excerpt}</p>
        <div className="flex items-center gap-3 pt-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs font-semibold text-white shadow-md shadow-violet-500/20">
            {post.author.name.split(' ').slice(0, 2).map((s) => s[0]).join('')}
          </div>
          <div>
            <div className="text-sm font-medium text-neutral-100">{post.author.name}</div>
            <div className="text-[11px] text-neutral-500">{post.author.role}</div>
          </div>
        </div>
      </header>

      <div className="mt-12 prose prose-invert prose-lg max-w-none prose-headings:tracking-tight prose-headings:text-white prose-h2:mt-12 prose-h2:text-2xl prose-h2:font-semibold prose-h3:text-xl prose-p:leading-relaxed prose-p:text-neutral-300 prose-a:font-medium prose-a:text-cyan-300 prose-a:no-underline hover:prose-a:underline prose-strong:font-semibold prose-strong:text-neutral-100 prose-code:rounded prose-code:bg-neutral-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[14px] prose-code:font-medium prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-xl prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-neutral-950 prose-li:my-1 prose-li:text-neutral-300 prose-blockquote:border-l-4 prose-blockquote:border-cyan-500/40 prose-blockquote:not-italic prose-blockquote:text-neutral-300 prose-table:my-8 prose-th:text-left prose-th:font-semibold prose-th:text-neutral-100 prose-td:text-neutral-300">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{post.body}</ReactMarkdown>
      </div>

      <section className="mt-20 overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 p-8 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-white">
          Want to try it yourself?
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-300">
          5 free scans a month. AI triage on every finding. No credit card.
        </p>
        <Link
          href="/signup"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-md shadow-white/15 hover:shadow-lg"
        >
          Start free
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </Link>
      </section>
    </main>
  );
}
