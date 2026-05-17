'use client';

import { useState } from 'react';
import { Copy, Check, AlertCircle, Loader2, Trash2 } from 'lucide-react';

interface EnableResponse {
  ok: true;
  webhook_url: string;
  webhook_secret: string;
  repo_full_name: string;
  setup_steps: string[];
}

interface Props {
  integrationId: string;
  initialEnabled: boolean;
  initialRepoFullName: string | null;
  // GitHub username/org of the integration owner — used to pre-fill
  // "owner/repo" hint when the field is empty.
  login: string | null;
}

export default function PrScanningClient({
  integrationId,
  initialEnabled,
  initialRepoFullName,
  login,
}: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [repoFullName, setRepoFullName] = useState(initialRepoFullName ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [response, setResponse] = useState<EnableResponse | null>(null);
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);

  const enable = async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/integrations/${integrationId}/pr-scanning`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_full_name: repoFullName.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setResponse(json as EnableResponse);
      setEnabled(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    if (saving) return;
    if (!window.confirm('Disable PR scanning for this repo?\n\nYou will also need to remove the webhook on github.com.')) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/integrations/${integrationId}/pr-scanning`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setEnabled(false);
      setResponse(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (which: 'url' | 'secret', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard may be blocked. The user can select-and-copy from the field.
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-5">
        <label className="space-y-1.5 block">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
            Repository
          </span>
          <input
            type="text"
            value={repoFullName}
            onChange={(e) => setRepoFullName(e.target.value)}
            placeholder={login ? `${login}/my-repo` : 'owner/repo'}
            disabled={enabled && !response}
            className="w-full rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-xs text-neutral-100 placeholder-neutral-600 focus:border-cyan-500/40 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 disabled:opacity-50"
          />
          <span className="block text-[10.5px] text-neutral-500">
            Must already be registered as a repository target. Add it via Targets → New if not.
          </span>
        </label>

        <div className="flex items-center gap-2">
          {!enabled || response ? (
            <button
              type="button"
              onClick={enable}
              disabled={saving || !repoFullName.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
              ) : null}
              {enabled ? 'Rotate webhook secret' : 'Enable PR scanning'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setResponse({ ...({} as EnableResponse) })}
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 ring-1 ring-neutral-700 hover:bg-neutral-700"
            >
              Re-show setup instructions
            </button>
          )}

          {enabled && (
            <button
              type="button"
              onClick={disable}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/20 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
              Disable
            </button>
          )}
        </div>

        {err && <div className="text-[11px] text-rose-300">{err}</div>}

        {enabled && !response && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-2 text-[11.5px] text-emerald-100">
            <Check className="mr-1 inline h-3.5 w-3.5" strokeWidth={2.5} />
            PR scanning is enabled. Webhook secret is set but hidden — rotate to
            see a new one.
          </div>
        )}
      </section>

      {response && response.webhook_url && (
        <section className="space-y-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/[0.05] p-5">
          <div className="flex items-start gap-2 text-[12px]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-cyan-300" strokeWidth={2.5} />
            <span className="leading-relaxed text-cyan-100">
              <strong>Save the secret below now — we never show it again.</strong>{' '}
              Paste these into your repo&apos;s{' '}
              <a
                href={`https://github.com/${response.repo_full_name}/settings/hooks/new`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                webhook settings
              </a>
              .
            </span>
          </div>

          <CopyField
            label="Payload URL"
            value={response.webhook_url}
            copied={copied === 'url'}
            onCopy={() => copy('url', response.webhook_url)}
          />
          <CopyField
            label="Secret"
            value={response.webhook_secret}
            copied={copied === 'secret'}
            onCopy={() => copy('secret', response.webhook_secret)}
          />

          <ol className="space-y-1 pl-4 text-[11.5px] leading-relaxed text-neutral-300">
            {response.setup_steps.map((s, i) => (
              <li key={i} className="list-decimal">
                {s.replace(/^\d+\.\s*/, '')}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          readOnly
          value={value}
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-[11px] text-neutral-200 hover:border-neutral-700"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-300" strokeWidth={2.5} />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" strokeWidth={2.25} />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
