import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import ApiKeysClient from './api-keys-client';

// Tier II #8 — API keys & MCP server config.
//
// Surfaces:
//   - List of existing API keys (prefix-visible only — secret is gone after mint)
//   - "+ New API key" → modal mints + shows the full key ONCE + setup snippets
//   - Cursor / Claude Code config snippets pinned at the top so a new
//     user can copy them right after minting
//
// Server-renders the existing key list so there's no flicker.

export default async function ApiKeysPage() {
  const supabase = createClient();
  const { data: keys } = await supabase
    .from('api_keys')
    .select(
      'id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at',
    )
    .order('created_at', { ascending: false });

  // Check membership role server-side so the page can grey-out the
  // mint button for viewers / members. Admin/owner only mints.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: membership } = user
    ? await supabase
        .from('org_members')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle()
    : { data: null };
  const canMint =
    membership !== null &&
    ['owner', 'admin'].includes((membership as { role?: string } | null)?.role ?? '');

  return (
    <div className="max-w-3xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">API keys & MCP</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">API keys & MCP</h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          Bearer tokens for the TensorShield MCP server. Paste one into{' '}
          <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-xs">.cursor/mcp.json</code> or{' '}
          <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-xs">
            ~/.config/claude-code/mcp_servers.json
          </code>{' '}
          so your AI assistant can ask TensorShield about your security posture.
        </p>
      </header>

      <ApiKeysClient
        initialKeys={(keys ?? []) as Array<{
          id: string;
          name: string;
          key_prefix: string;
          scopes: string[];
          expires_at: string | null;
          last_used_at: string | null;
          revoked_at: string | null;
          created_at: string;
        }>}
        canMint={canMint}
      />
    </div>
  );
}
