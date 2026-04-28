import { createClient } from '@/lib/supabase/server';
import SettingsClient from './settings-client';

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Resolve current org_id + role from the user's JWT.
  const session = await supabase.auth.getSession();
  const tok = session.data.session?.access_token;
  const claims: { org_id?: string; org_role?: string } = (() => {
    if (!tok) return {};
    try {
      return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
    } catch {
      return {};
    }
  })();

  const [{ data: profile }, { data: org }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user!.id).single(),
    claims.org_id
      ? supabase.from('organizations').select('*').eq('id', claims.org_id).single()
      : Promise.resolve({ data: null }),
  ]);

  return (
    <SettingsClient
      userEmail={user!.email ?? ''}
      profile={profile}
      org={org}
      orgRole={claims.org_role ?? null}
    />
  );
}
