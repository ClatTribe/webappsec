import { ImageResponse } from 'next/og';
import { SITE_NAME } from '@/lib/seo';

// Default OG image used by every page that doesn't override it. Per-page
// images live in colocated `app/.../opengraph-image.tsx` files (see
// app/(marketing)/blog/[slug]/opengraph-image.tsx). Twitter card uses the
// same generator via Next's twitter-image convention.

export const alt = `${SITE_NAME} — find real vulnerabilities, no false positives`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 80px',
          background:
            'radial-gradient(circle at 30% 20%, #0a3a4d 0%, #050a14 60%, #020610 100%)',
          color: '#fff',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              fontWeight: 600,
              color: '#fff',
              fontFamily: 'monospace',
            }}
          >
            y.
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: '#e5e7eb',
              gap: 8,
            }}
          >
            <span>your</span>
            <span style={{ color: '#22d3ee' }}>AI</span>
            <span>security engineer</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              fontSize: 72,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: '-0.025em',
              color: '#fff',
              maxWidth: 1040,
              gap: '0 18px',
            }}
          >
            <span>TensorShield —</span>
            <span
              style={{
                background:
                  'linear-gradient(135deg, #67e8f9 0%, #93c5fd 50%, #c4b5fd 100%)',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              the AI security
            </span>
            <span>engineer for vibe-coded apps.</span>
          </div>
          <div
            style={{
              fontSize: 28,
              color: '#94a3b8',
              fontWeight: 400,
              maxWidth: 920,
            }}
          >
            Scans your code. Remembers your decisions. 5 free scans / month.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 20,
            color: '#67e8f9',
            fontFamily: 'monospace',
          }}
        >
          → tensorshield.ai
        </div>
      </div>
    ),
    size,
  );
}
