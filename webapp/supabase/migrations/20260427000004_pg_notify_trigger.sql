-- Wake the worker when a new scan is queued.
-- The worker runs `LISTEN scan_queued` and reacts to NOTIFY payloads.

create or replace function public.notify_scan_queued()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'queued' then
    perform pg_notify('scan_queued', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists scans_queued_notify on public.scans;

create trigger scans_queued_notify
  after insert on public.scans
  for each row
  execute function public.notify_scan_queued();

-- Also fire when a scan is re-queued (status moves back to 'queued').
create or replace function public.notify_scan_requeued()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'queued' and old.status <> 'queued' then
    perform pg_notify('scan_queued', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists scans_requeued_notify on public.scans;

create trigger scans_requeued_notify
  after update of status on public.scans
  for each row
  execute function public.notify_scan_requeued();
