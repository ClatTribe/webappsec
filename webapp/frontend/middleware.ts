// Refreshes the Supabase session cookie on every request.
// Required by @supabase/ssr to keep server components in sync with the client.
// Also enforces auth-required routes (under /app/...) by redirecting to /login if no session.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  // SEO infrastructure. Dynamic routes that crawlers MUST be able to fetch
  // unauthenticated — without these the middleware redirected /sitemap.xml
  // and /robots.txt to /login, which silently breaks indexing.
  '/sitemap.xml',
  '/robots.txt',
  '/opengraph-image',
  '/twitter-image',
];
const PUBLIC_PREFIXES = [
  '/pricing',
  '/about',
  '/security',
  '/privacy',
  '/terms',
  '/contact',
  '/changelog',
  '/blog',
  '/.well-known',
  // Public Living Trust Page (migration 047). Each org opts in via
  // organizations.trust_page_enabled; the page payload comes from a
  // SECURITY DEFINER RPC that enforces the opt-in gate. Without this
  // prefix, /trust/<slug> would be redirected to /login and the page
  // would never reach an unauthenticated visitor.
  '/trust',
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not write code between createServerClient and getUser.
  // The presence of getUser keeps the JWT fresh.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic =
    PUBLIC_PATHS.includes(path) ||
    PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ||
    path.startsWith('/api/integrations/oauth/') ||
    path.startsWith('/_next') ||
    path.startsWith('/favicon');

  if (!user && !isPublic) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('next', path);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every page route except static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
