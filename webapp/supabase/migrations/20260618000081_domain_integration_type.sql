-- Widen integrations.type to include 'domain' — Phase A finisher.
--
-- The asset-discovery framework is integration-keyed, but the domain
-- discoverer doesn't have credentials to manage — its "config" is the
-- apex domain itself (e.g. `acme.com` → enumerate every subdomain we
-- find in cert-transparency logs and propose them as web_application
-- targets).
--
-- We model this as a `domain` integration: a thin row in
-- `integrations` whose vault payload is JSON `{"apex": "acme.com"}`
-- instead of a real credential. This lets the discoverer slot into
-- the existing framework with zero special cases — same runner, same
-- cron, same `/integrations/[id]/discovered` UI — and keeps RLS /
-- audit-log paths uniform.
--
-- The vault NOT NULL constraint stays; we write a real (but
-- non-sensitive) JSON payload. The decrypt path is unchanged.

alter table public.integrations drop constraint if exists integrations_type_check;
alter table public.integrations
  add constraint integrations_type_check
  check (type in (
    'github','gitlab','aws','azure','gcp','k8s','webhook','domain'
  ));

comment on column public.integrations.type is
  'github / gitlab / aws / azure / gcp / k8s / webhook / domain. The '
  '`domain` type (added 2026-05-18) is a wrapper-side abstraction: '
  'its vault payload is `{"apex": "<host>"}` and powers subdomain '
  'enumeration via certificate-transparency logs.';
