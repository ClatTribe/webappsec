'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Code2, Globe, Network, Folder, Server } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TargetType, ScanFrequency } from '@/lib/supabase/types';

const TYPES: { value: TargetType; label: string; example: string; Icon: LucideIcon }[] = [
  { value: 'repository', label: 'Git repository', example: 'https://github.com/me/myapp', Icon: Code2 },
  { value: 'web_application', label: 'Deployed web app', example: 'https://api.myapp.com', Icon: Globe },
  { value: 'domain', label: 'Domain', example: 'myapp.com', Icon: Globe },
  { value: 'ip_address', label: 'IP address', example: '203.0.113.10', Icon: Network },
  { value: 'local_code', label: 'Local code path', example: '/home/me/myapp', Icon: Folder },
];

function inferType(value: string): TargetType {
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(value) || /^git@/.test(value))
    return 'repository';
  if (/^https?:\/\//.test(value)) return 'web_application';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return 'ip_address';
  if (value.startsWith('./') || value.startsWith('/')) return 'local_code';
  return 'domain';
}

export default function NewTargetPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [type, setType] = useState<TargetType | null>(null);
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<ScanFrequency>('manual');
  const [autoDiscover, setAutoDiscover] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedType = type ?? inferType(value);
  const showAutoDiscover = resolvedType === 'domain';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!value.trim()) {
      setError('Add a target value (URL, domain, repo, etc.).');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || value.trim(),
        type: resolvedType,
        value: value.trim(),
        description: description.trim() || undefined,
        scan_frequency: frequency,
        // Only meaningful for domain targets — `/api/targets` ignores the
        // field for other types, but we still gate it client-side so the
        // request body matches what we asked the user.
        auto_discover: resolvedType === 'domain' ? autoDiscover : false,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to create target');
      return;
    }
    const { id } = await res.json();
    router.push(`/targets/${id}`);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
        <Link href="/targets" className="transition-colors hover:text-neutral-300">
          Targets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">New target</span>
      </nav>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Add target</h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          A target is an asset you want to scan repeatedly. After creating it, you can run scans
          against it on demand or on a schedule.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        <Field label="Value" hint="URL, repo, domain, IP, or local path">
          <input
            type="text"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://github.com/me/myapp"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
          {value && (
            <div className="mt-1.5 text-[11px] text-neutral-500">
              detected type: <span className="font-mono text-neutral-300">{resolvedType}</span>
            </div>
          )}
        </Field>

        <Field label="Name" hint="Human-friendly label. Defaults to the value.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production API"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
        </Field>

        <Field label="Type" hint="Override the auto-detected type if needed.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TYPES.map((t) => {
              const Icon = t.Icon;
              const active = resolvedType === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setType(t.value)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                    active
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                      : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What is this target? Any context for whoever scans it next."
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
        </Field>

        <Field label="Scan frequency" hint="Manual today; scheduled scans land in a future release.">
          <div className="flex flex-wrap gap-2">
            {(['manual', 'daily', 'weekly', 'monthly'] as ScanFrequency[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFrequency(f)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  frequency === f
                    ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30'
                    : 'bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800 hover:text-neutral-100'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </Field>

        {/* Subdomain auto-discovery — only for domain targets, opt-in.
            Defaulted off because not every user adding `staging.acme.com`
            wants their entire `acme.com` surface enumerated. */}
        {showAutoDiscover && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3.5 py-3 transition-colors hover:border-neutral-700">
            <input
              type="checkbox"
              checked={autoDiscover}
              onChange={(e) => setAutoDiscover(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-neutral-100">
                Discover subdomains via Certificate Transparency logs
              </div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-400">
                We&apos;ll look up <span className="font-mono text-neutral-300">{value || 'this domain'}</span>{' '}
                in public CT logs and suggest each discovered subdomain as a separate target.
                You decide which to scan — nothing is auto-scanned. Free, takes ~5 seconds.
              </div>
            </div>
          </label>
        )}

        {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create target'}
          </button>
          <Link href="/targets" className="text-sm text-neutral-400 hover:text-neutral-100">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-neutral-500">{hint}</div>}
    </label>
  );
}
