-- Engine PR #267 + #268 + #269 + #271 — first-class `api` target type.
--
-- The strix engine's lead-agent tool catalog now recognises `api` as a
-- distinct target type with its own ~50-tool set: it drops browser /
-- DOM / scan_xss / bfs_crawl (no signal against pure-JSON APIs) and
-- enables openapi_spec_ingest + the API-Top-10 specialists
-- (scan_api_bola, scan_api_bfla, scan_api_mass_assignment,
-- scan_api_rate_limit, graphql_introspection_deep, grpc_reflection_probe).
--
-- PR #271 landed the wrapper-callable contract: prefix `--target` with
-- `api:<value>` to force classification. Without this migration the
-- wrapper can't store an `api` row in `public.targets` at all (the
-- existing CHECK constraint rejects the literal).
--
-- Two constraints to update — the persistent targets table (where users
-- register assets they want to scan) and the ephemeral scan_targets
-- table (one row per target per scan run).
--
-- Both must be done in the same migration so a partial rollout doesn't
-- leave one side accepting `api` while the other rejects it.

alter table public.targets
  drop constraint targets_type_check;
alter table public.targets
  add constraint targets_type_check
  check (type in (
    'local_code',
    'repository',
    'web_application',
    'domain',
    'ip_address',
    'api'
  ));

alter table public.scan_targets
  drop constraint scan_targets_type_check;
alter table public.scan_targets
  add constraint scan_targets_type_check
  check (type in (
    'local_code',
    'repository',
    'web_application',
    'domain',
    'ip_address',
    'api'
  ));
