-- Per-org custom rule library — Snyk's "author your own Semgrep rule"
-- differentiator, with the wrapper as the editor + storage layer.
--
-- The wrapper owns the rule library; the worker dumps enabled rules
-- to a directory on the scan workdir + forwards STRIX_CUSTOM_RULES_DIR
-- to the engine subprocess. The engine consumes rules as Semgrep
-- format (the de-facto SAST rule shape — auditors recognise it,
-- developers can re-use rules from semgrep.dev).
--
-- This is the v1 schema. The wrapper supports per-org rule authoring,
-- enabled/disabled toggling, soft delete with audit trail. Engine-side
-- support for the env-var contract is the follow-up.

create table if not exists public.custom_rules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  -- Operator-visible name. Free-text, max 120 — must be unique within
  -- the org so the rule list reads cleanly and the engine can address
  -- a specific rule by its display label in finding emission.
  name            text not null check (length(name) between 1 and 120),
  -- Brief one-liner shown next to the name on the list. Optional.
  description     text check (length(description) <= 2048),
  -- Programming language scope. Mirrors Semgrep's `languages:` field.
  -- We don't enforce a CHECK because the catalog evolves (rust, kotlin,
  -- swift, ruby keep getting added); validation lives in the API zod
  -- schema where it's a code change, not a schema migration.
  language        text not null check (length(language) between 1 and 50),
  -- Severity stamped on every finding the rule produces. Matches the
  -- findings.severity check enum exactly.
  severity        text not null default 'medium'
    check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  -- Optional CWE tag the engine will stamp on each finding.
  cwe             text check (length(cwe) <= 50),
  -- The rule body — Semgrep YAML. We deliberately store the whole
  -- YAML rather than parsed fields because Semgrep's syntax has more
  -- than just pattern + message: it has `patterns`, `pattern-either`,
  -- `pattern-not`, `metavariable-regex`, `taint-mode`, etc. The
  -- wrapper does basic shape validation (presence of top-level
  -- `rules:`); the engine is the source of truth for what's actually
  -- a valid rule.
  rule_yaml       text not null check (length(rule_yaml) between 10 and 65536),
  enabled         boolean not null default true,
  -- The fingerprint of the rule body. Allows the worker to skip
  -- re-dumping unchanged rules on every scan and to detect when an
  -- operator's "edit" produced a duplicate by accident.
  rule_hash       text not null check (length(rule_hash) = 64),
  created_by      uuid not null references auth.users on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  -- Soft-delete preserves the audit trail. Hard-delete is intentionally
  -- not exposed.
  archived_at     timestamptz,
  archived_by     uuid references auth.users on delete set null,
  unique (org_id, name)
);

create index if not exists custom_rules_org_active
  on public.custom_rules (org_id, language)
  where archived_at is null and enabled = true;

create index if not exists custom_rules_org_all
  on public.custom_rules (org_id, created_at desc);

comment on table public.custom_rules is
  'Per-org custom Semgrep rule library. Worker dumps enabled rules '
  'into a workdir directory per scan + forwards STRIX_CUSTOM_RULES_DIR '
  'to the engine. Semgrep YAML lives in rule_yaml; severity / CWE / '
  'language extracted for indexing.';

-- ============================================================================
-- RLS — members read; member/admin/owner can write within their org
-- ============================================================================

alter table public.custom_rules enable row level security;

drop policy if exists custom_rules_org_read on public.custom_rules;
create policy custom_rules_org_read on public.custom_rules
  for select using (org_id = public.current_org_id());

drop policy if exists custom_rules_org_write on public.custom_rules;
create policy custom_rules_org_write on public.custom_rules
  for all
  using (org_id = public.current_org_id())
  with check (
    org_id = public.current_org_id()
    and exists (
      select 1 from public.org_members m
      where m.org_id = public.current_org_id()
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'member')
    )
  );

-- ============================================================================
-- updated_at autotouch + last_used_at touch RPC
-- ============================================================================

create or replace function public.touch_custom_rule_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists custom_rules_touch_updated_at on public.custom_rules;
create trigger custom_rules_touch_updated_at
  before update on public.custom_rules
  for each row
  execute function public.touch_custom_rule_updated_at();

-- Called by the worker on scan-start with the set of rule IDs it
-- actually dumped. Service-role only.
drop function if exists public.touch_custom_rules_last_used(uuid[]);

create or replace function public.touch_custom_rules_last_used(p_rule_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.custom_rules
     set last_used_at = now()
   where id = any(p_rule_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.touch_custom_rules_last_used(uuid[]) from public, anon, authenticated;
grant   execute on function public.touch_custom_rules_last_used(uuid[]) to service_role;

comment on function public.touch_custom_rules_last_used(uuid[]) is
  'Worker-side bump of last_used_at after a scan dumps enabled rules. '
  'Lets the UI show "this rule fired in the last scan" without a join '
  'through findings.';
