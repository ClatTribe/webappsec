import { createClient } from '@/lib/supabase/server';

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user?.id ?? '')
    .single();
  const { data: org } = await supabase.from('organizations').select('*').limit(1).single();

  return (
    <div className="max-w-xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium uppercase text-neutral-400">Profile</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Name" value={profile?.full_name ?? '—'} />
          <Row label="Email" value={user?.email ?? '—'} />
        </dl>
      </section>

      <section className="rounded-md border border-neutral-800 p-4">
        <h2 className="text-sm font-medium uppercase text-neutral-400">Organization</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Name" value={org?.name ?? '—'} />
          <Row label="Slug" value={org?.slug ?? '—'} />
          <Row label="Plan" value={org?.plan ?? '—'} />
          <Row label="LLM provider" value={org?.llm_provider ?? '(worker default)'} />
        </dl>
      </section>

      <p className="text-sm text-neutral-500">
        MFA, API tokens, billing, and webhooks land in Phase 1.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-neutral-100">{value}</dd>
    </div>
  );
}
