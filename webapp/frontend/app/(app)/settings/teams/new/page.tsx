'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';

export default function NewTeamPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch('/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || null,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to create team');
      return;
    }
    const body = (await res.json()) as { team: { slug: string } };
    router.push(`/settings/teams/${body.team.slug}`);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link href="/settings/teams" className="transition-colors hover:text-neutral-300">
          Teams
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">New</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-2xl font-semibold tracking-tight">Create team</h1>
        </div>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="flex flex-col text-sm">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Payments security squad"
            required
            maxLength={120}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </label>

        <label className="flex flex-col text-sm">
          Slug{' '}
          <span className="text-[11px] font-normal text-neutral-500">
            (URL-safe, optional — defaults to{' '}
            <code className="font-mono">{autoSlug || '<from name>'}</code>)
          </span>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder={autoSlug || 'payments-security'}
            pattern="^[a-z0-9][a-z0-9-]*$"
            maxLength={64}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col text-sm">
          Description{' '}
          <span className="text-[11px] font-normal text-neutral-500">(optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2048}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs"
          />
        </label>

        {error && (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create team'}
          </button>
          <Link
            href="/settings/teams"
            className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-700"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
