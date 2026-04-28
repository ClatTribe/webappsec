import Link from 'next/link';
import { ArrowRight, Calendar, Clock } from 'lucide-react';
import { buildPageMetadata } from '@/lib/seo';
import { getAllPosts } from './posts';

export const metadata = buildPageMetadata({
  title: 'Blog',
  description:
    'Notes from the team. Engineering, product, application-security writing — no growth-hack listicles.',
  path: '/blog',
});

export default function BlogIndex() {
  const posts = getAllPosts();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <header className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Blog</p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
          Notes from the team.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-neutral-300">
          Engineering deep-dives, product thinking, and the occasional vulnerability writeup. We
          don't write listicles. We do write the actual prompts and code that ship.
        </p>
      </header>

      <div className="mt-14 space-y-8">
        {posts.map((p) => (
          <article
            key={p.slug}
            className="group rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 transition-all hover:border-neutral-700 lg:p-8"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {p.date}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {p.readingTime}
              </span>
              {p.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300"
                >
                  {t}
                </span>
              ))}
            </div>
            <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-white">
              <Link
                href={`/blog/${p.slug}`}
                className="transition-colors group-hover:text-cyan-200"
              >
                {p.title}
              </Link>
            </h2>
            <p className="mt-3 text-base leading-relaxed text-neutral-300">{p.excerpt}</p>
            <div className="mt-5 flex items-center justify-between">
              <span className="text-xs text-neutral-500">By {p.author.name}</span>
              <Link
                href={`/blog/${p.slug}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-cyan-300 transition-transform group-hover:translate-x-0.5"
              >
                Read post
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
              </Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
