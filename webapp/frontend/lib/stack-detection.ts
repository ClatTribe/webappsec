// Tier II #9 — pure stack detection.
//
// Input: a map of repo filename → file content string (truncated to ~16KB
// is fine — we only inspect manifests). Output: a structured shape that
// tells the wizard what kind of app this is and how to scan it.
//
// We deliberately keep this *pure and offline*: no network calls, no
// runtime deps. The route layer fetches files via GitHub API; the
// analysis is a unit-testable function. That keeps the detection
// logic out of the network-mocking hellscape and means we can add
// new heuristics without touching the route.
//
// Mapping discipline (per CLAUDE.md §1): we surface what we detect
// verbatim. We do NOT auto-create scan modes / probes based on the
// stack — Strix's specialists are what determines coverage. The
// wizard just uses the detected stack to choose a sensible default
// scan_mode and to suggest a target type (repository + optional
// web_application).

export type FrameworkKind =
  | 'nextjs'
  | 'remix'
  | 'astro'
  | 'vite'
  | 'svelte'
  | 'nuxt'
  | 'gatsby'
  | 'express'
  | 'fastify'
  | 'nestjs'
  | 'koa'
  | 'fastapi'
  | 'django'
  | 'flask'
  | 'rails'
  | 'go-stdlib'
  | 'rust-actix'
  | 'spring'
  | 'unknown';

export type HostingKind =
  | 'vercel'
  | 'netlify'
  | 'fly'
  | 'railway'
  | 'render'
  | 'heroku'
  | 'aws-amplify'
  | 'cloudflare-pages'
  | 'docker'
  | 'unknown';

export type LanguageKind =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'java'
  | 'php'
  | 'unknown';

export type ScanModeSuggestion = 'quick' | 'standard' | 'deep';

export interface DetectedStack {
  language: LanguageKind;
  frameworks: FrameworkKind[];
  hosting: HostingKind[];
  /** Whether the repo has any indication of being an API service
   *  (no UI / pure backend). Drives the default target type. */
  is_api: boolean;
  /** Whether the repo has any indication of being a frontend / web
   *  app (has Next.js, has a build script, has a public folder). */
  is_web: boolean;
  /** Whether the repo carries credentials in committed files —
   *  catches the "we accidentally pushed .env.production" pattern.
   *  When non-empty, the wizard surfaces a warning chip; the user
   *  shouldn't be running a scan against a repo that's already
   *  leaking secrets. */
  leaked_secrets: string[];
  /** Best-guess production URL from hosting manifests. Optional —
   *  the wizard asks the user to confirm before creating a target. */
  suggested_prod_url: string | null;
  /** Default scan_mode for the suggested target. We bias toward
   *  'standard' for web apps and 'quick' for APIs (which tend to
   *  iterate faster on PRs); deep is opt-in. */
  suggested_scan_mode: ScanModeSuggestion;
  /** Free-form notes the wizard can show to the user — "we see a
   *  Dockerfile so we'll also offer a container_image target." */
  notes: string[];
}

export function detectStack(files: Record<string, string>): DetectedStack {
  const has = (path: string) => path in files;
  const read = (path: string) => files[path] ?? '';
  const lower = (s: string) => s.toLowerCase();

  // ---- Language --------------------------------------------------
  let language: LanguageKind = 'unknown';
  if (has('package.json')) {
    // tsconfig.json present? then typescript. Otherwise treat as JS.
    language = has('tsconfig.json') ? 'typescript' : 'javascript';
  } else if (
    has('requirements.txt') ||
    has('pyproject.toml') ||
    has('Pipfile')
  ) {
    language = 'python';
  } else if (has('go.mod')) {
    language = 'go';
  } else if (has('Cargo.toml')) {
    language = 'rust';
  } else if (has('Gemfile')) {
    language = 'ruby';
  } else if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    language = 'java';
  } else if (has('composer.json')) {
    language = 'php';
  }

  // ---- Frameworks ------------------------------------------------
  const frameworks = new Set<FrameworkKind>();

  if (has('package.json')) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(read('package.json'));
    } catch {
      // Malformed JSON — treat as no info. The wizard will just show
      // less detail rather than crashing.
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('next' in deps || has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) {
      frameworks.add('nextjs');
    }
    if ('@remix-run/react' in deps || '@remix-run/node' in deps || has('remix.config.js')) {
      frameworks.add('remix');
    }
    if ('astro' in deps || has('astro.config.mjs') || has('astro.config.ts')) {
      frameworks.add('astro');
    }
    if ('nuxt' in deps || has('nuxt.config.ts') || has('nuxt.config.js')) {
      frameworks.add('nuxt');
    }
    if ('@sveltejs/kit' in deps || 'svelte' in deps || has('svelte.config.js')) {
      frameworks.add('svelte');
    }
    if ('gatsby' in deps || has('gatsby-config.js')) {
      frameworks.add('gatsby');
    }
    if ('vite' in deps || has('vite.config.ts') || has('vite.config.js')) {
      frameworks.add('vite');
    }
    if ('express' in deps) frameworks.add('express');
    if ('fastify' in deps) frameworks.add('fastify');
    if ('@nestjs/core' in deps) frameworks.add('nestjs');
    if ('koa' in deps) frameworks.add('koa');
  }

  // Python signal — pyproject is the most authoritative.
  if (has('pyproject.toml')) {
    const py = lower(read('pyproject.toml'));
    if (py.includes('fastapi')) frameworks.add('fastapi');
    if (py.includes('django')) frameworks.add('django');
    if (py.includes('flask')) frameworks.add('flask');
  } else if (has('requirements.txt')) {
    const reqs = lower(read('requirements.txt'));
    if (reqs.includes('fastapi')) frameworks.add('fastapi');
    if (reqs.includes('django')) frameworks.add('django');
    if (reqs.includes('flask')) frameworks.add('flask');
  }

  // Ruby
  if (has('Gemfile') && lower(read('Gemfile')).includes('rails')) {
    frameworks.add('rails');
  }
  // Java — coarse-grained (Spring vs not). We only care if Spring's in here.
  if (has('pom.xml') && lower(read('pom.xml')).includes('spring')) {
    frameworks.add('spring');
  }
  // Go — std-lib net/http is the default. We tag it explicitly so the
  // wizard can suggest a web target rather than just "go service".
  if (has('go.mod')) {
    frameworks.add('go-stdlib');
  }
  // Rust — actix is the most-scanned framework target.
  if (has('Cargo.toml') && lower(read('Cargo.toml')).includes('actix-web')) {
    frameworks.add('rust-actix');
  }

  // ---- Hosting ---------------------------------------------------
  const hosting = new Set<HostingKind>();
  if (has('vercel.json') || (has('package.json') && /@vercel\//.test(read('package.json')))) {
    hosting.add('vercel');
  }
  if (has('netlify.toml')) hosting.add('netlify');
  if (has('fly.toml')) hosting.add('fly');
  if (has('railway.toml') || has('railway.json')) hosting.add('railway');
  if (has('render.yaml')) hosting.add('render');
  if (has('Procfile')) hosting.add('heroku');
  if (has('amplify.yml')) hosting.add('aws-amplify');
  if (has('wrangler.toml')) hosting.add('cloudflare-pages');
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yml')) {
    hosting.add('docker');
  }

  // ---- Production URL (best-effort from hosting manifests) -------
  let suggested_prod_url: string | null = null;

  if (has('vercel.json')) {
    try {
      const v = JSON.parse(read('vercel.json')) as { alias?: string | string[] };
      const alias = Array.isArray(v.alias) ? v.alias[0] : v.alias;
      if (typeof alias === 'string' && alias.length > 0) {
        suggested_prod_url = alias.startsWith('http') ? alias : `https://${alias}`;
      }
    } catch {
      // Malformed — skip.
    }
  }

  if (!suggested_prod_url && has('netlify.toml')) {
    // netlify.toml doesn't carry the canonical URL — they're set in
    // Netlify's dashboard. But we can scan for a comment / context
    // block with a domain. Best-effort regex; we accept false-positives
    // (the user confirms the URL before we create a target).
    const m = read('netlify.toml').match(/(?:url|domain)\s*=\s*["']([^"']+)["']/i);
    if (m) {
      suggested_prod_url = m[1].startsWith('http') ? m[1] : `https://${m[1]}`;
    }
  }

  if (!suggested_prod_url && has('fly.toml')) {
    const m = read('fly.toml').match(/^app\s*=\s*["']([a-z0-9-]+)["']/m);
    if (m) {
      // Fly's default URL is <app>.fly.dev — we surface that as a
      // guess; user can override.
      suggested_prod_url = `https://${m[1]}.fly.dev`;
    }
  }

  // ---- Leaked-secret check --------------------------------------
  // Tier II #9 — if .env / .env.production / .env.local etc landed in
  // the repo manifest list, that's a pre-emptive security finding the
  // wizard surfaces *before* scan #1. Cheap heuristic; not exhaustive.
  const leaked: string[] = [];
  for (const f of Object.keys(files)) {
    const lf = lower(f);
    if (lf === '.env' || lf.startsWith('.env.')) {
      // We only flag the manifest *name* being present in the repo
      // tree. The route layer chooses whether to fetch contents.
      leaked.push(f);
    }
  }

  // ---- Verdict synthesis ----------------------------------------
  const fws = [...frameworks];
  const webFws: FrameworkKind[] = [
    'nextjs',
    'remix',
    'astro',
    'nuxt',
    'svelte',
    'gatsby',
    'vite',
    'rails',
    'django',
  ];
  const apiFws: FrameworkKind[] = [
    'fastapi',
    'flask',
    'express',
    'fastify',
    'nestjs',
    'koa',
    'go-stdlib',
    'rust-actix',
    'spring',
  ];

  const is_web = fws.some((f) => webFws.includes(f));
  const is_api = fws.some((f) => apiFws.includes(f)) || (!is_web && fws.length > 0);

  const notes: string[] = [];
  if (hosting.has('docker') && !hosting.has('vercel') && !hosting.has('netlify')) {
    notes.push("We see a Dockerfile — we'll also offer a container_image target after scan #1.");
  }
  if (leaked.length > 0) {
    notes.push(
      `Found ${leaked.length} .env-style file${leaked.length === 1 ? '' : 's'} in the repo — review for committed secrets BEFORE scan #1.`,
    );
  }
  if (fws.length === 0 && language === 'unknown') {
    notes.push("No common manifest detected. We'll still scan as a generic repository.");
  }

  // Scan-mode default: web → standard (richer DAST surface),
  // api → quick (PR-scan-friendly), neither → quick.
  const suggested_scan_mode: ScanModeSuggestion = is_web
    ? 'standard'
    : 'quick';

  return {
    language,
    frameworks: fws,
    hosting: [...hosting],
    is_api,
    is_web,
    leaked_secrets: leaked,
    suggested_prod_url,
    suggested_scan_mode,
    notes,
  };
}

// Friendly display names. Keep in sync with the kinds above.
export const FRAMEWORK_LABEL: Record<FrameworkKind, string> = {
  nextjs: 'Next.js',
  remix: 'Remix',
  astro: 'Astro',
  vite: 'Vite',
  svelte: 'SvelteKit',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  express: 'Express',
  fastify: 'Fastify',
  nestjs: 'NestJS',
  koa: 'Koa',
  fastapi: 'FastAPI',
  django: 'Django',
  flask: 'Flask',
  rails: 'Rails',
  'go-stdlib': 'Go (net/http)',
  'rust-actix': 'Actix Web',
  spring: 'Spring',
  unknown: 'Unknown',
};

export const HOSTING_LABEL: Record<HostingKind, string> = {
  vercel: 'Vercel',
  netlify: 'Netlify',
  fly: 'Fly.io',
  railway: 'Railway',
  render: 'Render',
  heroku: 'Heroku',
  'aws-amplify': 'AWS Amplify',
  'cloudflare-pages': 'Cloudflare Pages',
  docker: 'Docker',
  unknown: 'Self-hosted',
};

export const LANGUAGE_LABEL: Record<LanguageKind, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java',
  php: 'PHP',
  unknown: '—',
};

// Files the route should fetch from a repo for analysis. Keeping the
// list short keeps the GitHub API budget reasonable (10 requests is
// fine; 100 would be wasteful for a quick wizard).
export const FILES_TO_INSPECT: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'vercel.json',
  'netlify.toml',
  'fly.toml',
  'railway.toml',
  'railway.json',
  'render.yaml',
  'Procfile',
  'amplify.yml',
  'wrangler.toml',
  'Dockerfile',
  'docker-compose.yml',
  'compose.yml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'remix.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'nuxt.config.ts',
  'nuxt.config.js',
  'svelte.config.js',
  'vite.config.ts',
  'vite.config.js',
  'gatsby-config.js',
] as const;
