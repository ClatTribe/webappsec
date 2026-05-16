// Tier II #7 — shared GitHub REST helpers.
//
// Tiny adapter that adds (a) consistent Authorization + UA headers,
// (b) typed JSON parsing, (c) a helpful error path. Borrowed shape
// from the apply-patch route helpers in PR #99; lifted here for
// reuse by the PR comment bot (and future GitHub-touching code:
// SARIF upload, JIRA/Linear webhooks).
//
// Intentionally NOT @octokit/rest: octokit pulls 600KB of deps for
// the handful of endpoints we hit and would force us into runtime=
// nodejs on every route that uses it. Bare fetch keeps us
// runtime=edge-compatible for cold-start latency on webhook
// receivers.

const UA = 'tensorshield-webapp';

export function parseGitHubRepoUrl(value: string): { owner: string; repo: string } | null {
  const cleaned = value.trim();
  // https://github.com/<owner>/<repo>(.git)?
  const httpsMatch = cleaned.match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // git@github.com:<owner>/<repo>(.git)?
  const sshMatch = cleaned.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

export async function ghFetch(
  url: string,
  token: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<Response> {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.extraHeaders ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export async function ghJson<T = unknown>(
  url: string,
  token: string,
  init?: Parameters<typeof ghFetch>[2],
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await ghFetch(url, token, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text || `${res.status}` };
  }
  // 204 no-content is rare on GET but legal — return a typed-cast of undefined.
  if (res.status === 204) return { ok: true, data: undefined as unknown as T };
  return { ok: true, data: (await res.json()) as T };
}

// Constant-time HMAC SHA-256 hex compare for webhook signatures.
// GitHub sends `sha256=<hex>` in the X-Hub-Signature-256 header.
//
// We deliberately implement the compare manually rather than reaching
// for `crypto.timingSafeEqual` because the latter requires equal-length
// Buffers — a length mismatch (attacker passes a too-short sig) would
// throw rather than reject, leaking a tiny timing signal. The bitwise
// OR-accumulator below is constant-time regardless of input lengths.
export async function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const match = signatureHeader.match(/^sha256=([a-f0-9]+)$/i);
  if (!match) return false;
  const provided = match[1];

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
