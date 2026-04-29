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
  | 'domain'
  | 'ip_address'
  | 'local_code';

export function configSchemaFor(type: TargetType) {
  switch (type) {
    case 'repository':
      return RepositoryConfig;
    case 'web_application':
      return WebApplicationConfig;
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
