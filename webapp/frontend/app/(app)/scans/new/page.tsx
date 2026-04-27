'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Integration, ScanMode } from '@/lib/supabase/types';

export default function NewScanPage() {
  const router = useRouter();
  const supabase = createClient();
  const [targets, setTargets] = useState<string[]>(['']);
  const [scanMode, setScanMode] = useState<ScanMode>('standard');
  const [instruction, setInstruction] = useState('');
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('integrations')
      .select('*')
      .eq('status', 'active')
      .then(({ data }) => setIntegrations((data ?? []) as Integration[]));
  }, [supabase]);

  function setTarget(i: number, value: string) {
    setTargets((t) => t.map((v, idx) => (idx === i ? value : v)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const cleanTargets = targets.map((t) => t.trim()).filter(Boolean);
    if (cleanTargets.length === 0) {
      setError('Add at least one target.');
      setSubmitting(false);
      return;
    }

    const res = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: cleanTargets,
        scan_mode: scanMode,
        instruction_text: instruction.trim() || null,
        integration_ids: integrationIds,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to queue scan');
      setSubmitting(false);
      return;
    }

    const { scan_id } = await res.json();
    router.push(`/scans/${scan_id}`);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">New scan</h1>

      <form onSubmit={onSubmit} className="space-y-6">
        <section>
          <label className="text-sm font-medium">Targets</label>
          <p className="text-xs text-neutral-400">
            Repos (https://github.com/...), URLs (https://example.com), domains, or IPs.
          </p>
          <div className="mt-2 space-y-2">
            {targets.map((target, i) => (
              <input
                key={i}
                type="text"
                value={target}
                placeholder="https://github.com/myorg/myrepo"
                onChange={(e) => setTarget(i, e.target.value)}
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              />
            ))}
            <button
              type="button"
              onClick={() => setTargets((t) => [...t, ''])}
              className="text-sm text-neutral-400 hover:text-white"
            >
              + Add another target
            </button>
          </div>
        </section>

        <section>
          <label className="text-sm font-medium">Scan mode</label>
          <div className="mt-2 flex gap-2">
            {(['quick', 'standard', 'deep'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScanMode(mode)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  scanMode === mode
                    ? 'border-white bg-white text-neutral-950'
                    : 'border-neutral-700 hover:border-neutral-500'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label className="text-sm font-medium">Integrations</label>
          <p className="text-xs text-neutral-400">
            Authorize the agent to use connected GitHub, AWS, Kubernetes, etc.
          </p>
          <div className="mt-2 space-y-1">
            {integrations.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No integrations yet — set them up in Integrations.
              </p>
            ) : (
              integrations.map((i) => (
                <label key={i.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={integrationIds.includes(i.id)}
                    onChange={(e) =>
                      setIntegrationIds((cur) =>
                        e.target.checked ? [...cur, i.id] : cur.filter((id) => id !== i.id),
                      )
                    }
                  />
                  <span className="text-neutral-300">
                    [{i.type}] {i.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </section>

        <section>
          <label className="text-sm font-medium">Instructions (optional)</label>
          <p className="text-xs text-neutral-400">
            Test credentials, scope, focus areas. Free-form text.
          </p>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={6}
            placeholder="Authenticate as user:pass and focus on IDOR vulnerabilities."
            className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          />
        </section>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-neutral-200 disabled:opacity-50"
        >
          {submitting ? 'Queuing...' : 'Start scan'}
        </button>
      </form>
    </div>
  );
}
