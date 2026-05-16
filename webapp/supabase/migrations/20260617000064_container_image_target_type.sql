-- Engine PR #274 — first-class `container_image` target type.
--
-- Strix now ships scan_container_image (Trivy wrapper) + a dedicated
-- tool catalog entry + a CLI prefix validator that rejects image-
-- refs with URL schemes / whitespace / illegal chars. The wrapper
-- couldn't store such a row at all today — `targets.type` CHECK
-- accepts {local_code, repository, web_application, api, domain,
-- ip_address} but not `container_image`.
--
-- One migration, two CHECK constraints:
--   * public.targets.type
--   * public.scan_targets.type
--
-- The wrapper passes `--target container_image:<ref>` to the engine
-- when the tenant picks "Container image" in the UI; engine's prefix
-- contract (PR #271 / PR #274) routes to scan_container_image without
-- the URL-shape inference the other types use. Image refs are
-- ambiguous with `host:port` (`nginx:1.25` vs `localhost:1025`) so
-- the prefix is REQUIRED — both engine-side and wrapper-side, the
-- inference path is never invoked for container_image targets.

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
    'api',
    'container_image'
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
    'api',
    'container_image'
  ));
