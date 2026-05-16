'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Sparkles,
  X,
  GitBranch,
  ChevronRight,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Code2,
  Cloud,
  Globe,
} from 'lucide-react';
import { FRAMEWORK_LABEL, HOSTING_LABEL, LANGUAGE_LABEL } from '@/lib/stack-detection';
import type { DetectedStack } from '@/lib/stack-detection';

// Tier II #9 — onboarding wizard.
//
// One modal, several screens. The user can dismiss (X / "Skip for now")
// at any time — the dialog is non-blocking even when shown.
//
// State machine:
//   intro       → "Welcome — detect my stack" or "Skip"
//   needs_gh    → no github integration → link to /integrations/new/github
//   picking     → repos loaded, user picks one
//   analyzing   → inspect-repo API call running
//   review      → DetectedStack rendered, form for prod URL + names
//   pairing     → complete-pairing API call running
//   done        → "All set!" + CTA to /scans/new

interface Integration {
  id: string;
  type: string;
  status: string;
  name: string;
  metadata?: { login?: string };
}

interface Repo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string | null;
  already_imported?: boolean;
}

interface InspectResponse {
  ok: true;
  owner: string;
  repo: string;
  ref: string;
  files_inspected: string[];
  stack: DetectedStack;
}

type Step = 'intro' | 'needs_gh' | 'picking' | 'analyzing' | 'review' | 'pairing' | 'done';

interface Props {
  /** Initial integration list passed in from the server-rendered shell.
   *  Saves a round-trip on first render and avoids a flash of "needs_gh"
   *  while the client-side fetch resolves. */
  initialIntegrations: Integration[];
}

export default function OnboardingDialog({ initialIntegrations }: Props) {
  const router = useRouter();

  // ---- top-level dialog visibility ---------------------------------
  // Mount the dialog open; the server-side render guard upstream
  // ensures we only mount when state === 'pending' or 'in_progress'.
  const [visible, setVisible] = useState(true);

  // ---- state machine ----------------------------------------------
  const ghIntegrations = initialIntegrations.filter((i) => i.type === 'github' && i.status === 'active');
  const [step, setStep] = useState<Step>(
    ghIntegrations.length > 0 ? 'intro' : 'intro',
  );
  const [integrationId, setIntegrationId] = useState<string | null>(ghIntegrations[0]?.id ?? null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [pickedRepo, setPickedRepo] = useState<Repo | null>(null);
  const [inspectData, setInspectData] = useState<InspectResponse | null>(null);
  const [prodUrl, setProdUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [prodName, setProdName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [createdRepoTargetId, setCreatedRepoTargetId] = useState<string | null>(null);

  // ---- skip / start API helpers -----------------------------------
  const mutateState = async (action: 'start' | 'skip' | 'complete') => {
    await fetch('/api/onboarding/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  };

  const handleSkip = async () => {
    await mutateState('skip');
    setVisible(false);
    router.refresh();
  };

  const handleStart = async () => {
    if (ghIntegrations.length === 0) {
      setStep('needs_gh');
      return;
    }
    await mutateState('start');
    setStep('picking');
    if (repos === null && integrationId) {
      loadRepos(integrationId);
    }
  };

  // ---- repo listing ------------------------------------------------
  const loadRepos = async (intId: string) => {
    setErr(null);
    setRepos(null);
    try {
      const res = await fetch(`/api/integrations/${intId}/repos`);
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setRepos((json.repos ?? []) as Repo[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load repos');
    }
  };

  // ---- inspect ----------------------------------------------------
  const handlePickRepo = async (r: Repo) => {
    if (!integrationId) return;
    setPickedRepo(r);
    setRepoName(r.name);
    setStep('analyzing');
    setErr(null);
    try {
      const [owner, repo] = r.full_name.split('/');
      const res = await fetch('/api/onboarding/inspect-repo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ integration_id: integrationId, owner, repo }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        setStep('picking');
        return;
      }
      const data = json as InspectResponse;
      setInspectData(data);
      if (data.stack.suggested_prod_url) {
        setProdUrl(data.stack.suggested_prod_url);
        // Default the prod target name to "owner/repo (prod)".
        setProdName(`${r.full_name} (prod)`);
      }
      setStep('review');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'inspection failed');
      setStep('picking');
    }
  };

  // ---- complete pairing ------------------------------------------
  const handleCompletePairing = async () => {
    if (!pickedRepo || !inspectData || !integrationId) return;
    setStep('pairing');
    setErr(null);
    try {
      const res = await fetch('/api/onboarding/complete-pairing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo_url: pickedRepo.html_url,
          repo_name: repoName.trim() || pickedRepo.name,
          integration_id: integrationId,
          prod_url: prodUrl.trim() ? prodUrl.trim() : null,
          prod_name: prodUrl.trim() ? prodName.trim() || `${pickedRepo.full_name} (prod)` : null,
          suggested_scan_mode: inspectData.stack.suggested_scan_mode,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        setStep('review');
        return;
      }
      setCreatedRepoTargetId(json.repo_target_id);
      setStep('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'pairing failed');
      setStep('review');
    }
  };

  // ---- ESC closes the dialog (consistent with native modal UX) ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && visible) {
        void handleSkip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // We don't include handleSkip in deps — re-binding on every render
    // is fine for a one-key handler and the inner closure reads the
    // latest `visible` thanks to React's render-locked state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl ring-1 ring-cyan-500/10">
        {/* Top bar: brand + close --------------------------------- */}
        <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-4 w-4 text-cyan-300" strokeWidth={2.25} />
            <span className="text-[12px] font-semibold uppercase tracking-wider text-neutral-300">
              Set up your first scan
            </span>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            title="Skip for now (esc)"
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>

        {/* Body --------------------------------------------------- */}
        <div className="p-6">
          {step === 'intro' && <IntroStep onStart={handleStart} onSkip={handleSkip} />}
          {step === 'needs_gh' && <NeedsGitHubStep />}
          {step === 'picking' && (
            <PickingStep
              integrations={ghIntegrations}
              integrationId={integrationId}
              onPickIntegration={(id) => {
                setIntegrationId(id);
                loadRepos(id);
              }}
              repos={repos}
              err={err}
              onPickRepo={handlePickRepo}
            />
          )}
          {step === 'analyzing' && <AnalyzingStep />}
          {step === 'review' && inspectData && pickedRepo && (
            <ReviewStep
              repo={pickedRepo}
              data={inspectData}
              repoName={repoName}
              onRepoNameChange={setRepoName}
              prodUrl={prodUrl}
              onProdUrlChange={setProdUrl}
              prodName={prodName}
              onProdNameChange={setProdName}
              err={err}
              onBack={() => setStep('picking')}
              onConfirm={handleCompletePairing}
            />
          )}
          {step === 'pairing' && <PairingStep />}
          {step === 'done' && (
            <DoneStep
              repoTargetId={createdRepoTargetId}
              scanMode={inspectData?.stack.suggested_scan_mode ?? 'standard'}
              onClose={() => {
                setVisible(false);
                router.refresh();
              }}
            />
          )}
        </div>

        {/* Footer: persistent skip link ------------------------- */}
        {step !== 'done' && (
          <div className="border-t border-neutral-800/80 bg-neutral-950 px-5 py-2.5">
            <button
              type="button"
              onClick={handleSkip}
              className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
            >
              Skip for now — I&apos;ll set this up myself
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =============== Step components ====================================

function IntroStep({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Let&apos;s get your first scan running.
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
          TensorShield works best when it knows your stack. Connect a
          repo and we&apos;ll detect your framework, hosting, and
          production URL — then pre-fill your first scan target. Takes
          about a minute.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={onStart}
          className="flex items-center justify-between rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-left transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/15"
        >
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-cyan-100">
              <GitBranch className="h-4 w-4" strokeWidth={2.25} />
              Detect my stack
            </div>
            <div className="mt-1 text-[11px] leading-tight text-cyan-200/70">
              From a GitHub repo
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-cyan-300" strokeWidth={2.5} />
        </button>

        <button
          type="button"
          onClick={onSkip}
          className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
        >
          <div className="text-sm font-medium text-neutral-200">
            I&apos;ll set up manually
          </div>
          <div className="mt-1 text-[11px] leading-tight text-neutral-500">
            Add a URL or domain by hand
          </div>
        </button>
      </div>
    </div>
  );
}

function NeedsGitHubStep() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Connect GitHub first</h2>
        <p className="mt-1 text-sm text-neutral-400">
          We need read access to one of your repos to detect your stack. We never write to your code.
        </p>
      </div>
      <Link
        href="/integrations/new/github"
        className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
      >
        <GitBranch className="h-4 w-4" strokeWidth={2.25} />
        Connect GitHub
      </Link>
    </div>
  );
}

function PickingStep({
  integrations,
  integrationId,
  onPickIntegration,
  repos,
  err,
  onPickRepo,
}: {
  integrations: Integration[];
  integrationId: string | null;
  onPickIntegration: (id: string) => void;
  repos: Repo[] | null;
  err: string | null;
  onPickRepo: (r: Repo) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = (repos ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Pick a repo to inspect</h2>
        <p className="mt-1 text-sm text-neutral-400">
          We&apos;ll look at the manifest files only — no source code is sent off your account.
        </p>
      </div>

      {integrations.length > 1 && (
        <select
          value={integrationId ?? ''}
          onChange={(e) => onPickIntegration(e.target.value)}
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100"
        >
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.metadata?.login ? `@${i.metadata.login} · ${i.name}` : i.name}
            </option>
          ))}
        </select>
      )}

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter repos…"
        className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600"
      />

      {err && <div className="text-[11px] text-rose-300">{err}</div>}

      <ul className="max-h-72 space-y-1 overflow-auto rounded-md border border-neutral-800/80 bg-neutral-950/40 p-1">
        {repos === null ? (
          <li className="px-3 py-2 text-[11.5px] text-neutral-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" strokeWidth={2.5} />
            Loading repos…
          </li>
        ) : filtered.length === 0 ? (
          <li className="px-3 py-2 text-[11.5px] text-neutral-500">No repos match.</li>
        ) : (
          filtered.slice(0, 50).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPickRepo(r)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-cyan-500/10"
              >
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-neutral-100">
                    {r.full_name}
                    {r.already_imported && (
                      <span className="ml-2 text-[10px] text-neutral-500">(already added)</span>
                    )}
                  </div>
                  {r.description && (
                    <div className="truncate text-[10.5px] text-neutral-500">{r.description}</div>
                  )}
                </div>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-neutral-600" strokeWidth={2.5} />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function AnalyzingStep() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-cyan-300" strokeWidth={2.25} />
      <div className="mt-3 text-sm text-neutral-300">Inspecting manifests…</div>
      <div className="mt-1 text-[11px] text-neutral-500">
        Reading package.json, vercel.json, Dockerfile, and friends
      </div>
    </div>
  );
}

function ReviewStep({
  repo,
  data,
  repoName,
  onRepoNameChange,
  prodUrl,
  onProdUrlChange,
  prodName,
  onProdNameChange,
  err,
  onBack,
  onConfirm,
}: {
  repo: Repo;
  data: InspectResponse;
  repoName: string;
  onRepoNameChange: (v: string) => void;
  prodUrl: string;
  onProdUrlChange: (v: string) => void;
  prodName: string;
  onProdNameChange: (v: string) => void;
  err: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const s = data.stack;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          We looked at <span className="font-mono text-cyan-200">{repo.full_name}</span>
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          Confirm the details and we&apos;ll create your first scan target.
        </p>
      </div>

      {/* Stack chips --------------------------------------------- */}
      <div className="space-y-2 rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Code2 className="h-3.5 w-3.5 text-neutral-500" strokeWidth={2.5} />
          <Chip>{LANGUAGE_LABEL[s.language]}</Chip>
          {s.frameworks.map((f) => (
            <Chip key={f} tone="cyan">
              {FRAMEWORK_LABEL[f]}
            </Chip>
          ))}
          {s.frameworks.length === 0 && (
            <span className="text-[11px] italic text-neutral-500">no framework detected</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Cloud className="h-3.5 w-3.5 text-neutral-500" strokeWidth={2.5} />
          {s.hosting.length === 0 ? (
            <span className="text-[11px] italic text-neutral-500">no hosting manifest</span>
          ) : (
            s.hosting.map((h) => (
              <Chip key={h} tone="violet">
                {HOSTING_LABEL[h]}
              </Chip>
            ))
          )}
        </div>
        {s.notes.length > 0 && (
          <ul className="space-y-1 pt-1">
            {s.notes.map((n, i) => (
              <li key={i} className="text-[11px] text-neutral-400">
                · {n}
              </li>
            ))}
          </ul>
        )}
        {s.leaked_secrets.length > 0 && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-2 py-1.5 text-[11px] text-amber-100">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-300" strokeWidth={2.5} />
            <span>
              Found {s.leaked_secrets.length} <code className="font-mono">.env</code>-style file
              {s.leaked_secrets.length === 1 ? '' : 's'} in the repo —{' '}
              <strong>review for committed secrets</strong> before scan #1.
            </span>
          </div>
        )}
      </div>

      {/* Repo target name --------------------------------------- */}
      <Field label="Target name (repository)">
        <input
          type="text"
          value={repoName}
          onChange={(e) => onRepoNameChange(e.target.value)}
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100"
        />
      </Field>

      {/* Optional prod URL --------------------------------------- */}
      <Field
        label={
          <span className="flex items-center gap-1.5">
            <Globe className="h-3 w-3 text-neutral-500" strokeWidth={2.5} />
            Production URL <span className="font-normal text-neutral-500">(optional)</span>
          </span>
        }
      >
        <input
          type="url"
          value={prodUrl}
          onChange={(e) => onProdUrlChange(e.target.value)}
          placeholder="https://app.example.com"
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100 placeholder:text-neutral-600"
        />
        {prodUrl && (
          <input
            type="text"
            value={prodName}
            onChange={(e) => onProdNameChange(e.target.value)}
            placeholder="Web target name"
            className="mt-1.5 w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100 placeholder:text-neutral-600"
          />
        )}
      </Field>

      {err && <div className="text-[11px] text-rose-300">{err}</div>}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] text-neutral-400 hover:text-neutral-200"
        >
          ← Different repo
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!repoName.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.25} />
          Create target{prodUrl ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

function PairingStep() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-cyan-300" strokeWidth={2.25} />
      <div className="mt-3 text-sm text-neutral-300">Creating your target…</div>
    </div>
  );
}

function DoneStep({
  repoTargetId,
  scanMode,
  onClose,
}: {
  repoTargetId: string | null;
  scanMode: 'quick' | 'standard' | 'deep';
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30">
          <ShieldCheck className="h-5 w-5" strokeWidth={2.25} />
        </div>
        <div>
          <h2 className="text-lg font-semibold">You&apos;re set up.</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Run your first scan now — TensorShield will surface findings as soon as
            anything notable lands.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href={
            repoTargetId
              ? `/scans/new?target=${repoTargetId}&mode=${scanMode}`
              : '/scans/new'
          }
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-sm font-medium text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
        >
          Run first scan
        </Link>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-neutral-500 hover:text-neutral-200"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

// =============== Small UI helpers ===================================

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'cyan' | 'violet' }) {
  const cls = {
    neutral: 'bg-neutral-800/80 text-neutral-200 ring-neutral-700',
    cyan: 'bg-cyan-500/10 text-cyan-200 ring-cyan-400/30',
    violet: 'bg-violet-500/10 text-violet-200 ring-violet-400/30',
  }[tone];
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${cls}`}>
      {children}
    </span>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}
