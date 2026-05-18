-- Widen integrations.type to include 'okta' — for the Okta evidence
-- collector (continuous identity-provider posture audit).
--
-- Cred shape: vault payload `{ ssws_token, org_url }` where
-- ssws_token is a long-lived Okta API token (created by an Okta admin
-- with the "Read-Only Admin" role at minimum) and org_url is the full
-- Okta tenant URL (e.g. https://acme.okta.com).

alter table public.integrations drop constraint if exists integrations_type_check;
alter table public.integrations
  add constraint integrations_type_check
  check (type in (
    'github','gitlab','aws','azure','gcp','k8s','webhook','domain','okta'
  ));

comment on column public.integrations.type is
  'github / gitlab / aws / azure / gcp / k8s / webhook / domain / okta. '
  'The `okta` type (added 2026-05-18) powers the Okta evidence '
  'collector — continuous audit of identity-provider posture (MFA '
  'enforcement, admin sprawl, API token age, inactive accounts).';
