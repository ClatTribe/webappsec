// Per-target-type configuration shapes. Single source of truth for:
//   - the API zod parser on POST /api/targets
//   - the per-type form fields on /targets/new
//   - the Target.config type
//
// The worker reads the same shape from `targets.config` jsonb and translates
// each field into Strix-friendly instruction text in
// `runner._build_instruction`. The Python side mirrors this contract by hand —
// drift between the two is a bug; the augmenter unit tests catch most cases.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-type schemas
// ---------------------------------------------------------------------------

const NonEmptyStr = z.string().trim().min(1).max(500);

export const RepositoryConfig = z.object({
  // Git ref to scan. Default left to Strix's clone behaviour (usually `main`
  // or `master`). When set, the worker clones at this ref before invoking.
  branch: z.string().trim().max(200).optional(),
  // Monorepo: scope analysis to a sub-path. e.g. "apps/api".
  subdirectory: z.string().trim().max(200).optional(),
});

export const WebApplicationConfig = z.object({
  // Crawl seed URLs — comma-separated list, parsed in the form layer. Strix
  // treats these as the primary entrypoints rather than the bare host.
  crawl_seeds: z.array(NonEmptyStr).max(20).optional(),
  // Hard rate-limit hint, requests per second. Today this goes into the
  // instruction text — the agent self-limits in natural language. A real
  // CLI flag is on the wishlist (Priority 2 — `--rate-limit`).
  rate_limit_qps: z.number().int().positive().max(1000).optional(),
});

// Engine PRs #267 + #268 + #269 + #271 — first-class `api` target type.
// The strix lead routes api targets to a separate ~50-tool catalog that
// drops browser / DOM / scan_xss / bfs_crawl and enables the OWASP API
// Top 10 specialists (BOLA, BFLA, mass assignment, rate_limit) plus
// openapi_spec_ingest and graphql / grpc deep probes. To force this
// routing, the worker passes `--target api:<value>` to the engine
// (PR #271 contract).
export const ApiConfig = z.object({
  // Optional spec URL — the engine probes 11 standard paths automatically
  // (/openapi.json, /swagger.json, /v3/api-docs, …) but a tenant who
  // hosts their spec elsewhere can point us at it directly. Worker
  // forwards as `--openapi <url>` / `STRIX_OPENAPI_URL`.
  spec_url: z.string().trim().url().max(500).optional(),
  // Same shape as web_application — both consume an HTTP surface.
  rate_limit_qps: z.number().int().positive().max(1000).optional(),
});

// Engine PR #274 — first-class `container_image` target type.
// Routed to scan_container_image (Trivy wrapper) + threat_intel
// lookups + sbom_extract. DAST tools deliberately excluded — a
// registry-resident artefact has no live surface to probe. CLI
// contract: `--target container_image:<ref>` (prefix REQUIRED — image
// refs are ambiguous with host:port like `nginx:1.25` vs
// `localhost:1025`).
export const ContainerImageConfig = z.object({
  // Optional severity threshold passed to Trivy. Without it, Trivy
  // emits everything from LOW upward; production users typically
  // want HIGH+. Worker forwards via instruction text since the
  // engine's tool reads it from the lead's planning context.
  severity_floor: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  // Image-pull credentials registry hint. v1 expects users to put
  // the registry's auth in the worker's docker config; per-target
  // pull-credential storage is a follow-up. We surface the toggle
  // so the UI can warn when scanning a private-registry image
  // without per-org auth wired.
  private_registry: z.boolean().optional(),
});

export const DomainConfig = z.object({
  // Glob excludes for subdomain auto-discovery. Even with auto_discover on,
  // the user may want to skip "*-staging.*" or "internal-*". Filtered both
  // at discovery write-time and at scan-target promotion.
  subdomain_excludes: z.array(NonEmptyStr).max(50).optional(),
});

export const IpAddressConfig = z.object({
  // nmap-style port spec: "80,443,1-1024,8080-8090". When unset, Strix
  // picks a default set (typically the top-1000 TCP ports).
  port_spec: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\d,\s\-]+$/, { message: 'digits, commas, and ranges only' })
    .optional(),
  protocols: z.enum(['tcp', 'udp', 'both']).optional(),
});

export const LocalCodeConfig = z.object({
  // Same as repository but applied to a worker-side filesystem path.
  path_excludes: z.array(NonEmptyStr).max(50).optional(),
  language_hints: z.array(NonEmptyStr).max(20).optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union — typed by `targets.type`
// ---------------------------------------------------------------------------

// We model the union by parsing the raw `config` blob with the schema for
// the resolved target type. Zod has discriminatedUnion for tagged unions
// but our tag (target.type) lives outside the config object, so a manual
// switch is cleaner than wrapping every config with a redundant `type` key.

export type TargetType =
  | 'repository'
  | 'web_application'
  | 'api'
  | 'container_image'
  | 'domain'
  | 'ip_address'
  | 'local_code';

export function configSchemaFor(type: TargetType) {
  switch (type) {
    case 'repository':
      return RepositoryConfig;
    case 'web_application':
      return WebApplicationConfig;
    case 'api':
      return ApiConfig;
    case 'container_image':
      return ContainerImageConfig;
    case 'domain':
      return DomainConfig;
    case 'ip_address':
      return IpAddressConfig;
    case 'local_code':
      return LocalCodeConfig;
  }
}

export type TargetConfigOf<T extends TargetType> = T extends 'repository'
  ? z.infer<typeof RepositoryConfig>
  : T extends 'web_application'
    ? z.infer<typeof WebApplicationConfig>
    : T extends 'api'
      ? z.infer<typeof ApiConfig>
      : T extends 'container_image'
        ? z.infer<typeof ContainerImageConfig>
        : T extends 'domain'
          ? z.infer<typeof DomainConfig>
          : T extends 'ip_address'
            ? z.infer<typeof IpAddressConfig>
            : T extends 'local_code'
              ? z.infer<typeof LocalCodeConfig>
              : never;

/** Shape-validate `config` for the given target type. Throws ZodError on bad
 *  data; returns the parsed object on success. */
export function parseTargetConfig(type: TargetType, raw: unknown): unknown {
  return configSchemaFor(type).parse(raw ?? {});
}
