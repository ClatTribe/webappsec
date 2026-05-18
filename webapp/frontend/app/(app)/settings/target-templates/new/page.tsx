'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, Layers } from 'lucide-react';

const ASSET_TYPES = [
  ['', 'Any (no type restriction)'],
  ['repository', 'Repository'],
  ['web_application', 'Web application'],
  ['api', 'API'],
  ['container_image', 'Container image'],
  ['cloud_account', 'Cloud account'],
  ['domain', 'Domain'],
  ['ip_address', 'IP address'],
  ['local_code', 'Local code upload'],
] as const;

// Phase B — create-template form. Config is a JSONB blob the user
// edits as JSON. We validate parse-ability client-side; the server
// will reject anything else.

export default function NewTargetTemplatePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [assetType, setAssetType] = useState('');
  const [description, setDescription] = useState('');
  const [configText, setConfigText] = useState(
    JSON.stringify(
      {
        scan_mode: 'standard',
        scan_frequency: 'weekly',
        rate_limit_qps: 5,
        exclude_paths: ['/healthz', '/metrics'],
      },
      null,
      2,
    ),
  );
  const [tagsText, setTagsText] = useState('{}');
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

    let parsedConfig: Record<string, unknown>;
    let parsedTags: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configText);
    } catch {
      setError('Config is not valid JSON.');
      setSubmitting(false);
      return;
    }
    try {
      parsedTags = JSON.parse(tagsText);
    } catch {
      setError('Tags is not valid JSON.');
      setSubmitting(false);
      return;
    }

    const res = await fetch('/api/target-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || null,
        asset_type: assetType || null,
        config: parsedConfig,
        tags: parsedTags,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to create template.');
      return;
    }
    const body = (await res.json()) as { template: { slug: string } };
    router.push(`/settings/target-templates/${body.template.slug}`);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link
          href="/settings/target-templates"
          className="transition-colors hover:text-neutral-300"
        >
          Target templates
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">New</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-2xl font-semibold tracking-tight">
            Create target template
          </h1>
        </div>
        <p className="text-sm text-neutral-400">
          Shared config that attached targets inherit. Use the JSON editor to
          set common keys: <code className="font-mono">scan_mode</code>,{' '}
          <code className="font-mono">scan_frequency</code>,{' '}
          <code className="font-mono">rate_limit_qps</code>,{' '}
          <code className="font-mono">exclude_paths</code>,{' '}
          <code className="font-mono">seed_urls</code>, etc.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="flex flex-col text-sm">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prod web apps"
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
            placeholder={autoSlug || 'prod-web-apps'}
            pattern="^[a-z0-9][a-z0-9-]*$"
            maxLength={64}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          />
        </label>

        <label className="flex flex-col text-sm">
          Asset type
          <select
            value={assetType}
            onChange={(e) => setAssetType(e.target.value)}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            {ASSET_TYPES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <span className="mt-1 text-[10.5px] text-neutral-500">
            Restricts which target types this template can attach to.
          </span>
        </label>

        <label className="flex flex-col text-sm">
          Description{' '}
          <span className="text-[11px] font-normal text-neutral-500">(optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={2048}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs"
          />
        </label>

        <label className="flex flex-col text-sm">
          Config{' '}
          <span className="text-[11px] font-normal text-neutral-500">
            (JSON; merged with each target&apos;s own config — target keys win)
          </span>
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={10}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
          />
        </label>

        <label className="flex flex-col text-sm">
          Tags{' '}
          <span className="text-[11px] font-normal text-neutral-500">
            (JSON; merged onto attached targets&apos; metadata.tags)
          </span>
          <textarea
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            rows={3}
            className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px]"
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
            {submitting ? 'Creating…' : 'Create template'}
          </button>
          <Link
            href="/settings/target-templates"
            className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-700"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
