'use client';

import { useState } from 'react';
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  Trash2,
  Loader2,
  AlertTriangle,
  Sparkles,
  Terminal,
} from 'lucide-react';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Props {
  initialKeys: ApiKey[];
  canMint: boolean;
}

const AVAILABLE_SCOPES = [
  { id: 'mcp:read', label: 'Read findings & targets', detail: 'List + drill into findings, list targets.' },
  { id: 'mcp:scan', label: 'Kick scans', detail: 'Allow the LLM to start scans (counts toward your scan budget).' },
  { id: 'mcp:review', label: 'Quick security review', detail: 'Rule-based review of code snippets passed inline.' },
] as const;

export default function ApiKeysClient({ initialKeys, canMint }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [showMint, setShowMint] = useState(false);
  const [mintedKey, setMintedKey] = useState<{
    full_key: string;
    key: ApiKey;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleRevoke = async (id: string) => {
    if (!window.confirm('Revoke this API key? MCP clients using it will get 401 on next call.')) return;
    setErr(null);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setKeys((prev) =>
        prev.map((k) =>
          k.id === id
            ? { ...k, revoked_at: json.revoked_at ?? new Date().toISOString() }
            : k,
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* MCP setup callout ------------------------------------------ */}
      <SetupCallout />

      {/* Mint CTA -------------------------------------------------- */}
      <section className="flex items-center justify-between rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
            Your API keys
          </h2>
          <p className="mt-0.5 text-[11.5px] text-neutral-500">
            {keys.filter((k) => !k.revoked_at).length} active ·{' '}
            {keys.filter((k) => k.revoked_at).length} revoked
          </p>
        </div>
        <button
          type="button"
          disabled={!canMint}
          onClick={() => {
            setMintedKey(null);
            setShowMint(true);
            setErr(null);
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          title={canMint ? '' : 'Only org owners / admins can mint keys'}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New API key
        </button>
      </section>

      {err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {err}
        </div>
      )}

      {/* Existing keys list --------------------------------------- */}
      <ul className="space-y-2">
        {keys.length === 0 ? (
          <li className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-6 text-center text-[12px] text-neutral-500">
            No API keys yet. Mint one to connect Cursor or Claude Code.
          </li>
        ) : (
          keys.map((k) => <KeyRow key={k.id} k={k} onRevoke={handleRevoke} canRevoke={canMint} />)
        )}
      </ul>

      {/* Mint modal ----------------------------------------------- */}
      {showMint && (
        <MintModal
          onClose={() => setShowMint(false)}
          onMinted={(full_key, key) => {
            setMintedKey({ full_key, key });
            setKeys((prev) => [key, ...prev]);
          }}
        />
      )}

      {/* Post-mint reveal modal ----------------------------------- */}
      {mintedKey && (
        <RevealModal
          fullKey={mintedKey.full_key}
          prefix={mintedKey.key.key_prefix}
          name={mintedKey.key.name}
          onClose={() => setMintedKey(null)}
        />
      )}
    </div>
  );
}

// ============== sub-components ======================================

function SetupCallout() {
  const [copied, setCopied] = useState<'cursor' | 'cc' | null>(null);
  const copy = async (which: 'cursor' | 'cc', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // ignore
    }
  };

  const cursorSnippet = `{
  "mcpServers": {
    "tensorshield": {
      "url": "${typeof window !== 'undefined' ? window.location.origin : 'https://app.tensorshield.ai'}/api/mcp",
      "headers": {
        "Authorization": "Bearer ts_xxxxxxx"
      }
    }
  }
}`;

  return (
    <section className="space-y-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
        <h2 className="text-sm font-medium uppercase tracking-wider text-cyan-200">
          Connect Cursor / Claude Code
        </h2>
      </div>
      <p className="text-[12.5px] leading-relaxed text-neutral-300">
        Mint a key below, then add the snippet to your editor&apos;s MCP config.
        Restart the editor; you&apos;ll see TensorShield&apos;s 5 tools available to
        your AI assistant.
      </p>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
            ~/.cursor/mcp.json &middot; ~/.config/claude-code/mcp_servers.json
          </span>
          <button
            type="button"
            onClick={() => copy('cursor', cursorSnippet)}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10.5px] text-neutral-200 hover:border-neutral-600"
          >
            {copied === 'cursor' ? (
              <>
                <Check className="h-2.5 w-2.5 text-emerald-300" strokeWidth={2.5} /> Copied
              </>
            ) : (
              <>
                <Copy className="h-2.5 w-2.5" strokeWidth={2.25} /> Copy
              </>
            )}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-200">
{cursorSnippet}
        </pre>
      </div>
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-400">
        <Terminal className="mr-1 inline h-3 w-3 align-text-bottom text-neutral-500" strokeWidth={2.5} />
        Test from the command line:
        <pre className="mt-1.5 overflow-x-auto font-mono text-[10.5px] text-neutral-300">
{`curl -s ${typeof window !== 'undefined' ? window.location.origin : 'https://app.tensorshield.ai'}/api/mcp \\
  -H "Authorization: Bearer ts_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
        </pre>
      </div>
    </section>
  );
}

function KeyRow({
  k,
  onRevoke,
  canRevoke,
}: {
  k: ApiKey;
  onRevoke: (id: string) => void;
  canRevoke: boolean;
}) {
  const isRevoked = !!k.revoked_at;
  const isExpired = !!k.expires_at && new Date(k.expires_at) < new Date();
  return (
    <li
      className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
        isRevoked || isExpired
          ? 'border-neutral-800/60 bg-neutral-900/20 opacity-60'
          : 'border-neutral-800/80 bg-neutral-900/40'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-neutral-100">{k.name}</span>
          <code className="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-400">
            ts_{k.key_prefix}…
          </code>
          {isRevoked && (
            <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-200">
              revoked
            </span>
          )}
          {!isRevoked && isExpired && (
            <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-200">
              expired
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-neutral-500">
          <span>
            scopes: <span className="font-mono text-neutral-400">{k.scopes.join(' · ')}</span>
          </span>
          <span>
            created: {new Date(k.created_at).toLocaleDateString()}
          </span>
          {k.last_used_at && (
            <span>
              last used: {new Date(k.last_used_at).toLocaleString()}
            </span>
          )}
          {k.expires_at && !isRevoked && (
            <span>expires: {new Date(k.expires_at).toLocaleDateString()}</span>
          )}
        </div>
      </div>
      {!isRevoked && (
        <button
          type="button"
          onClick={() => onRevoke(k.id)}
          disabled={!canRevoke}
          className="inline-flex items-center gap-1.5 rounded-md bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/20 disabled:opacity-50"
          title={canRevoke ? 'Revoke this key' : 'Only owners / admins can revoke'}
        >
          <Trash2 className="h-3 w-3" strokeWidth={2.25} />
          Revoke
        </button>
      )}
    </li>
  );
}

function MintModal({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (fullKey: string, k: ApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['mcp:read', 'mcp:scan', 'mcp:review']);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      onMinted(json.full_key, json.key as ApiKey);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="text-lg font-semibold">New API key</h2>
        <label className="block space-y-1">
          <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My laptop · Cursor"
            maxLength={120}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600"
          />
        </label>
        <fieldset className="space-y-1.5">
          <legend className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
            Scopes
          </legend>
          {AVAILABLE_SCOPES.map((s) => (
            <label
              key={s.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11.5px] hover:border-neutral-700"
            >
              <input
                type="checkbox"
                checked={scopes.includes(s.id)}
                onChange={(e) =>
                  setScopes((prev) =>
                    e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                  )
                }
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-neutral-200">{s.label}</div>
                <div className="text-[10.5px] text-neutral-500">{s.detail}</div>
              </div>
            </label>
          ))}
        </fieldset>
        {err && <div className="text-[11px] text-rose-300">{err}</div>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[11.5px] text-neutral-500 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || scopes.length === 0 || submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-[12px] font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />}
            Mint key
          </button>
        </div>
      </div>
    </div>
  );
}

function RevealModal({
  fullKey,
  prefix,
  name,
  onClose,
}: {
  fullKey: string;
  prefix: string;
  name: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-cyan-500/30 bg-neutral-950 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" strokeWidth={2.5} />
          <div>
            <h2 className="text-lg font-semibold">Save this key — it&apos;s shown only once.</h2>
            <p className="mt-1 text-[12px] text-neutral-400">
              <span className="text-neutral-200">{name}</span> · prefix <code>ts_{prefix}…</code>. After
              you close this dialog, we keep only the SHA-256 of the key — there&apos;s no
              way to recover it. Lost it? Mint a new one and revoke this.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
            Full key
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={fullKey}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100"
            />
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-[11px] text-neutral-200 hover:border-neutral-700"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-300" strokeWidth={2.5} /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" strokeWidth={2.25} /> Copy
                </>
              )}
            </button>
          </div>
        </div>

        <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-3 font-mono text-[10.5px] leading-relaxed text-neutral-300">
{`{
  "mcpServers": {
    "tensorshield": {
      "url": "${typeof window !== 'undefined' ? window.location.origin : 'https://app.tensorshield.ai'}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${fullKey}"
      }
    }
  }
}`}
        </pre>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-[12px] font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
          >
            I&apos;ve saved it
          </button>
        </div>
      </div>
    </div>
  );
}
