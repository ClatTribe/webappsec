-- Add scan_events and findings to the Realtime publication so client-side subscriptions work.
-- Supabase Realtime forwards postgres_changes to subscribed clients, filtered by RLS.

-- The default supabase_realtime publication is created when Supabase is initialized.
-- Add our tables.

alter publication supabase_realtime add table public.scan_events;
alter publication supabase_realtime add table public.findings;
alter publication supabase_realtime add table public.scans;
