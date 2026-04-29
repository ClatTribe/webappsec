-- Make subdomain auto-discovery opt-in (roadmap §9 follow-up).
--
-- The original migration 014 fired discovery on every domain insert. That's
-- the wrong default — not every user adding `staging.acme.com` wants their
-- whole `acme.com` surface enumerated. Add a per-target flag, default off,
-- and update the notify triggers to honor it.
--
--   - INSERT a domain with auto_discover=true      → fires the notify
--   - INSERT a domain with auto_discover=false     → no notify (no extra
--                                                    work, no upstream
--                                                    crt.sh load, no
--                                                    surprise discoveries)
--   - UPDATE a target to flip auto_discover=true   → fires the notify
--                                                    (so the user can
--                                                    enable it later from
--                                                    the target detail
--                                                    page without
--                                                    re-creating)
--   - UPDATE auto_discover=false                   → no-op (existing
--                                                    pending discoveries
--                                                    stay; user can
--                                                    dismiss them
--                                                    manually)
--
-- Defense in depth: the worker also re-checks the flag before hitting
-- crt.sh, so a stray NOTIFY can't bypass the user's choice.

-- ============================================================
-- Schema: opt-in flag on targets
-- ============================================================

alter table public.targets
  add column if not exists auto_discover boolean not null default false;

-- ============================================================
-- Update the existing INSERT-time trigger to gate on the flag
-- ============================================================

create or replace function public.notify_target_discovery_requested()
returns trigger
language plpgsql
as $$
begin
  -- Two gates: the type must be discovery-capable, AND the user must have
  -- explicitly opted in. The flag default is false, so a plain insert
  -- never fires.
  if new.type = 'domain' and new.auto_discover = true then
    perform pg_notify('target_discovery_requested', new.id::text);
  end if;
  return new;
end;
$$;

-- ============================================================
-- New AFTER UPDATE trigger so users can flip the flag on later
-- ============================================================

create or replace function public.notify_target_discovery_on_enable()
returns trigger
language plpgsql
as $$
begin
  -- Fire only on a false→true transition. UPDATEs that don't touch
  -- auto_discover (or that flip it off) are no-ops, so unrelated edits
  -- to a target don't accidentally re-trigger discovery.
  if new.type = 'domain'
     and new.auto_discover = true
     and (old.auto_discover is distinct from new.auto_discover) then
    perform pg_notify('target_discovery_requested', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists targets_after_update_discovery on public.targets;
create trigger targets_after_update_discovery
  after update of auto_discover on public.targets
  for each row
  execute function public.notify_target_discovery_on_enable();
