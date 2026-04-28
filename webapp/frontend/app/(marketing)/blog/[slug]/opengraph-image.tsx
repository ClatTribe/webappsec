import { ImageResponse } from 'next/og';
import { SITE_NAME } from '@/lib/seo';
import { getAllPosts, getPostBySlug } from '../posts';

// Per-post OG image. Renders the post title large with the brand mark.
// Cached statically since posts are static themselves.

export const alt = 'Blog post';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Pre-render an image for every post at build time.
export function generateImageMetadata() {
  return getAllPosts().map((p) => ({ id: p.slug, alt: p.title }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const post = getPostBySlug(params.slug);
  const title = post?.title ?? 'Blog post';
  const date = post?.date ?? '';
  const tag = post?.tags[0] ?? 'Notes';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 80px',
          background:
            'radial-gradient(circle at 75% 30%, #1e3a5f 0%, #050a14 65%, #020610 100%)',
          color: '#fff',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 26,
                fontWeight: 600,
                color: '#fff',
                fontFamily: 'monospace',
              }}
            >
              y.
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: '#e5e7eb',
              }}
            >
              {SITE_NAME}
            </div>
          </div>
          <div
            style={{
              padding: '8px 16px',
              borderRadius: 999,
              background: 'rgba(34, 211, 238, 0.12)',
              color: '#67e8f9',
              fontSize: 18,
              fontWeight: 500,
              border: '1px solid rgba(34, 211, 238, 0.3)',
            }}
          >
            {tag}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
          }}
        >
          <div
            style={{
              fontSize: 60,
              fontWeight: 600,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: '#fff',
              maxWidth: 1040,
              display: 'flex',
            }}
          >
            {title}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: '#94a3b8',
            fontSize: 20,
          }}
        >
          <div style={{ fontFamily: 'monospace' }}>{date}</div>
          <div style={{ color: '#67e8f9', fontFamily: 'monospace' }}>
            youraisecurityengineer
          </div>
        </div>
      </div>
    ),
    size,
  );
}
