'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  ChevronRight,
  Globe,
  ArrowRight,
  AlertCircle,
  Settings2,
} from 'lucide-react';

// /assets/new/web — focused single-purpose form for "add a web app URL".
//
// This is the path the Home empty-state "Add a web app URL" card
// links to. Symmetric with /integrations/new/github and
// /integrations/new/aws — each starter card has its own focused
// form, none drops the user into a generic type picker.
//
// Mid-onboarding the user knows ONE thing: their production URL.
// The form takes that, derives a name, and creates a
// web_application target. Authentication / exclude paths / custom
// cadence — the configuration knobs that matter for a real DAST run
// but don't matter at signup — get progressively disclosed via a
// "Show advanced" toggle that expands inline. Anything beyond what
// the toggle reveals lives on the full /assets/new form, which we
// link from the bottom of the page.

export default function NewWebAppPage() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cadence, setCadence] = useState<'manual' | 'daily' | 'weekly' | 'monthly'>(
    'weekly',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive a reasonable default name from the URL when the user
  // hasn't typed one. "https://app.acme.com" → "app.acme.com".
  const autoName = useMemo(() => {
    if (!url.trim()) return '';
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }, [url]);

  const canSubmit = url.trim().length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Normalise to https:// if the user pasted a bare hostname.
    let normalised = url.trim();
    if (!/^https?:\/\//i.test(normalised)) {
      normalised = `https://${normalised}`;
    }
    // Basic shape check — full validation lives server-side. We just
    // want to catch obvious typos before round-tripping.
    try {
      new URL(normalised);
    } catch {
      setError(`"${url}" doesn't look like a URL. Try https://acme.com.`);
      setSubmitting(false);
      return;
    }

    const finalName = name.trim() || autoName || normalised;
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: finalName,
        type: 'web_application',
        value: normalised,
        scan_frequency: cadence,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Failed to save.');
      return;
    }
    const created = (await res.json()) as { id?: string };
    if (created.id) {
      router.push(`/assets/${created.id}`);
    } else {
      router.push('/assets');
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/assets" className="transition-colors hover:text-neutral-300">
          Assets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Add a web app</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Add a web app</h1>
        </div>
        <p className="max-w-xl text-sm text-neutral-400">
          Paste your production URL. We&apos;ll drive a real browser through
          your site and try to exploit anything we find before flagging it.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="flex flex-col text-sm">
          <span className="text-neutral-200">Production URL</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://acme.com"
            autoFocus
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
          <span className="mt-1 text-[11px] text-neutral-500">
            We&apos;ll automatically add{' '}
            <code className="font-mono">https://</code> if you don&apos;t.
          </span>
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-neutral-200">
            Name{' '}
            <span className="text-[11px] font-normal text-neutral-500">
              {autoName ? `(defaults to ${autoName})` : '(optional)'}
            </span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={autoName || 'Acme production'}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
        </label>

        {/* Progressive disclosure — most users don't need anything
            below this line. Auth, exclude paths, seed URLs, rate
            limit all live on the full form. We surface a cadence
            picker here because it's the one knob a first-time user
            actually thinks about. */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[12px] text-cyan-300 hover:underline"
        >
          <Settings2 className="h-3 w-3" strokeWidth={2.25} />
          {showAdvanced ? 'Hide options' : 'Show options'}
        </button>

        {showAdvanced && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
            <fieldset className="space-y-1.5">
              <legend className="text-sm text-neutral-200">Scan cadence</legend>
              <div className="grid grid-cols-4 gap-2">
                {(['manual', 'daily', 'weekly', 'monthly'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCadence(c)}
                    className={`rounded-md border px-2 py-1.5 text-xs capitalize transition-colors ${
                      cadence === c
                        ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-100'
                        : 'border-neutral-700 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10.5px] text-neutral-500">
                Need authentication, exclude paths, or a rate limit?{' '}
                <Link
                  href="/assets/new?type=web_application"
                  className="text-cyan-300 hover:underline"
                >
                  Use the full form
                </Link>
                .
              </p>
            </fieldset>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2.25} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add web app'}
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
          <Link
            href="/assets"
            className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-700"
          >
            Cancel
          </Link>
        </div>
      </form>

      <p className="text-xs text-neutral-500">
        Adding something other than a web app?{' '}
        <Link href="/assets/new" className="text-cyan-300 hover:underline">
          Pick a different asset type
        </Link>
        .
      </p>
    </div>
  );
}
