'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, FolderKanban } from 'lucide-react';

// /projects/new — create form.
//
// Lean v1 form: name + criticality + description. Slug is auto-derived
// on the server from the name unless the user overrides it. Owner and
// tags are editable later from the detail page.

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [criticality, setCriticality] = useState<'tier_1' | 'tier_2' | 'tier_3' | 'tier_4'>(
    'tier_2',
  );
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
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim() || undefined,
          description: description.trim() || null,
          criticality,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        project?: { slug: string };
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? 'Failed to create project.');
        return;
      }
      const finalSlug = body.project?.slug ?? autoSlug;
      router.push(`/projects/${finalSlug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/projects" className="transition-colors hover:text-neutral-300">
          Projects
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">New</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <FolderKanban className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-2xl font-semibold tracking-tight">Create a project</h1>
        </div>
        <p className="text-sm text-neutral-400">
          Projects group related targets — the payments service, the marketing
          site, the auth service. Findings and compliance posture roll up to
          the project level so you can answer &quot;how&apos;s X doing?&quot;
          in one query.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="flex flex-col text-sm">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Payments service"
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
            placeholder={autoSlug || 'payments-service'}
            pattern="^[a-z0-9][a-z0-9-]*$"
            maxLength={64}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          />
        </label>

        <fieldset className="space-y-1.5">
          <legend className="text-sm">Criticality</legend>
          <p className="text-[11px] text-neutral-500">
            Drives urgent-finding routing + risk-weighted scoring.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['tier_1', 'Tier 1', 'Prod data plane'],
                ['tier_2', 'Tier 2', 'Customer-facing'],
                ['tier_3', 'Tier 3', 'Internal tools'],
                ['tier_4', 'Tier 4', 'Sandboxes'],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => setCriticality(value)}
                className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  criticality === value
                    ? 'border-violet-500/40 bg-violet-500/10 text-violet-100'
                    : 'border-neutral-700 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600'
                }`}
              >
                <div className="font-medium">{label}</div>
                <div className="mt-0.5 text-[10px] text-neutral-500">{hint}</div>
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col text-sm">
          Description{' '}
          <span className="text-[11px] font-normal text-neutral-500">
            (optional, max 2048 chars)
          </span>
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
            {submitting ? 'Creating…' : 'Create project'}
          </button>
          <Link
            href="/projects"
            className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-700"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
