import { createClient } from '@/lib/supabase/server';

export default async function TeamPage() {
  const supabase = createClient();
  const { data: members } = await supabase
    .from('org_members')
    .select('*, profiles:user_id(*)')
    .order('created_at', { ascending: true });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-sm text-neutral-400">Members of your current organization.</p>
      </header>

      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-xs uppercase text-neutral-400">
            <tr>
              <th className="px-4 py-2">Member</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members?.map((m) => (
              <tr key={`${m.user_id}-${m.org_id}`} className="border-t border-neutral-800">
                <td className="px-4 py-2">
                  {(m.profiles as { full_name?: string } | null)?.full_name ?? m.user_id}
                </td>
                <td className="px-4 py-2">{m.role}</td>
                <td className="px-4 py-2 text-neutral-400">
                  {new Date(m.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-neutral-500">
        Invitations & role changes coming in Phase 1 — for now, add members directly via the
        Supabase dashboard.
      </p>
    </div>
  );
}
