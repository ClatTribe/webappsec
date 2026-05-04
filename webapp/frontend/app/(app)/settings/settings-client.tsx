'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  User,
  Building2,
  Sparkles,
  Lock,
  Loader2,
  Check,
  AlertCircle,
  KeyRound,
  Trash2,
  Brain,
  RotateCcw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface Props {
  userEmail: string;
  profile: { id: string; full_name: string | null; avatar_url: string | null } | null;
  org: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    llm_provider: string | null;
    llm_api_key_secret_id: string | null;
  } | null;
  orgRole: string | null;
}

const POPULAR_MODELS = [
  { value: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash (cheap, fast)' },
  { value: 'gemini/gemini-2.5-pro', label: 'Gemini 2.5 Pro (recommended for deep scans)' },
  { value: 'openai/gpt-5.4', label: 'OpenAI GPT-5.4 (Strix recommended)' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Anthropic Claude Sonnet 4.6 (Strix recommended)' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek (cheap, OSS-friendly)' },
];

export default function SettingsClient({ userEmail, profile, org, orgRole }: Props) {
  const isOwner = orgRole === 'owner';
  const router = useRouter();

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1.5 text-sm text-neutral-400">
          Manage your profile and organization. The LLM key here is what the worker uses to drive
          scans — it&apos;s stored encrypted in Supabase Vault and only ever decrypted in the
          worker&apos;s memory at scan time.
        </p>
      </header>

      <ProfileSection
        userEmail={userEmail}
        initialName={profile?.full_name ?? ''}
        onSaved={() => router.refresh()}
      />

      {org && (
        <OrgSection
          org={org}
          isOwner={isOwner}
          orgRole={orgRole}
          onSaved={() => router.refresh()}
        />
      )}

      {org && isOwner && (
        <LlmSection
          org={org}
          onSaved={() => router.refresh()}
        />
      )}

      {/* AI triage controls. Drift metric for everyone in the org;
          reset/trim actions gated to owner+admin server-side
          (reset_triage_signals RPC enforces it). */}
      {org && (
        <TriageControlsSection
          isAdmin={orgRole === 'owner' || orgRole === 'admin'}
        />
      )}

      {/* Engine FP auto-dismiss policy (Tier 2 closure). The engine reads
          this org's feedback.jsonl and auto-dismisses prior-FP fingerprints;
          the policy decides how aggressively. Per-org setting on
          organizations.fp_auto_dismiss_policy; admin-gated. */}
      {org && (orgRole === 'owner' || orgRole === 'admin') && (
        <FpAutoDismissSection
          orgId={org.id}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}

// ============== PROFILE ==============

function ProfileSection({
  userEmail,
  initialName,
  onSaved,
}: {
  userEmail: string;
  initialName: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const dirty = name !== initialName;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setFeedback(null);
    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: name }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Failed to save' });
      return;
    }
    setFeedback({ kind: 'success', text: 'Saved' });
    onSaved();
  }

  return (
    <Section title="Profile" Icon={User}>
      <Field label="Email" hint="Email changes are handled via auth — coming later.">
        <input
          type="text"
          value={userEmail}
          disabled
          className="w-full cursor-not-allowed rounded-lg border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-sm text-neutral-400"
        />
      </Field>
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className={INPUT_CLASS}
        />
      </Field>
      <div className="flex items-center justify-end gap-3">
        {feedback && <FeedbackPill feedback={feedback} />}
        <SaveButton disabled={!dirty || saving} saving={saving} onClick={save}>
          Save profile
        </SaveButton>
      </div>
    </Section>
  );
}

// ============== ORG ==============

function OrgSection({
  org,
  isOwner,
  orgRole,
  onSaved,
}: {
  org: NonNullable<Props['org']>;
  isOwner: boolean;
  orgRole: string | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const dirty = name !== org.name;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${org.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Failed to save' });
      return;
    }
    setFeedback({ kind: 'success', text: 'Saved' });
    onSaved();
  }

  return (
    <Section
      title="Organization"
      Icon={Building2}
      hint={
        isOwner
          ? null
          : `Only owners can edit organization settings. You're a ${orgRole ?? 'member'}.`
      }
    >
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isOwner}
          className={isOwner ? INPUT_CLASS : INPUT_CLASS_DISABLED}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug" hint="URL-impacting; not editable here.">
          <input
            type="text"
            value={org.slug}
            disabled
            className={INPUT_CLASS_DISABLED}
          />
        </Field>
        <Field label="Plan" hint="Billing-controlled.">
          <input
            type="text"
            value={org.plan}
            disabled
            className={INPUT_CLASS_DISABLED}
          />
        </Field>
      </div>
      {isOwner && (
        <div className="flex items-center justify-end gap-3">
          {feedback && <FeedbackPill feedback={feedback} />}
          <SaveButton disabled={!dirty || saving} saving={saving} onClick={save}>
            Save organization
          </SaveButton>
        </div>
      )}
    </Section>
  );
}

// ============== LLM ==============

function LlmSection({
  org,
  onSaved,
}: {
  org: NonNullable<Props['org']>;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(org.llm_provider ?? '');
  const [customProvider, setCustomProvider] = useState(
    org.llm_provider && !POPULAR_MODELS.find((m) => m.value === org.llm_provider) ? org.llm_provider : '',
  );
  const [providerMode, setProviderMode] = useState<'preset' | 'custom'>(
    org.llm_provider && !POPULAR_MODELS.find((m) => m.value === org.llm_provider) ? 'custom' : 'preset',
  );
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirming, setConfirming] = useState(false);

  const effectiveProvider = providerMode === 'preset' ? provider : customProvider;
  const providerDirty = (effectiveProvider || null) !== (org.llm_provider || null);
  const hasKey = !!org.llm_api_key_secret_id;

  async function saveProviderOnly() {
    if (!providerDirty) return;
    setSaving(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${org.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm_provider: effectiveProvider || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Failed to save provider' });
      return;
    }
    setFeedback({ kind: 'success', text: 'Provider saved' });
    onSaved();
  }

  async function saveKey() {
    if (apiKey.length < 8) {
      setFeedback({ kind: 'error', text: 'Paste a real API key (≥8 chars).' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${org.id}/llm-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        llm_provider: effectiveProvider || undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Failed to save key' });
      return;
    }
    setApiKey('');
    setFeedback({ kind: 'success', text: 'Key stored in Vault — workers will use it on the next scan.' });
    onSaved();
  }

  async function clearKey() {
    setSaving(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${org.id}/llm-key`, { method: 'DELETE' });
    setSaving(false);
    setConfirming(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Failed to clear key' });
      return;
    }
    setFeedback({ kind: 'success', text: 'Per-org key cleared. Workers fall back to the default LLM_API_KEY.' });
    onSaved();
  }

  return (
    <Section
      title="LLM provider"
      Icon={Sparkles}
      hint="Strix uses LiteLLM under the hood. Pick any LiteLLM-supported provider; the API key is stored in Supabase Vault and only decrypted server-side at scan time."
    >
      <Field label="Model">
        <div className="space-y-2">
          <div className="inline-flex rounded-lg bg-neutral-950/60 p-1 ring-1 ring-neutral-800">
            <ModeButton active={providerMode === 'preset'} onClick={() => setProviderMode('preset')}>
              Pick from list
            </ModeButton>
            <ModeButton active={providerMode === 'custom'} onClick={() => setProviderMode('custom')}>
              Custom string
            </ModeButton>
          </div>
          {providerMode === 'preset' ? (
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Use worker default</option>
              {POPULAR_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={customProvider}
              onChange={(e) => setCustomProvider(e.target.value)}
              placeholder="e.g. ollama/qwen2.5-coder:32b"
              className={`${INPUT_CLASS} font-mono`}
            />
          )}
          <p className="text-[11px] text-neutral-500">
            Format: <span className="font-mono text-neutral-300">provider/model</span>. See{' '}
            <a
              className="text-cyan-300 hover:underline"
              href="https://docs.litellm.ai/docs/providers"
              target="_blank"
              rel="noreferrer"
            >
              LiteLLM providers
            </a>
            .
          </p>
        </div>
      </Field>

      <Field
        label={
          <span className="flex items-center gap-1.5">
            API key
            {hasKey ? (
              <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/30">
                Set
              </span>
            ) : (
              <span className="rounded-md bg-neutral-700/50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-neutral-300 ring-1 ring-neutral-600/40">
                Not set
              </span>
            )}
          </span>
        }
        hint="Write-only. We never display the stored value. Paste a new key to rotate."
      >
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? '••••••••••••  (paste new key to rotate)' : 'sk-...'}
            className={`${INPUT_CLASS} font-mono`}
            autoComplete="off"
          />
          {hasKey && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-500/20"
              title="Clear stored key"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
          {hasKey && confirming && (
            <>
              <button
                type="button"
                onClick={clearKey}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-2 text-xs font-medium text-red-200 ring-1 ring-red-500/40 transition-colors hover:bg-red-500/30 disabled:opacity-50"
              >
                Confirm clear
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-neutral-800 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-700"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </Field>

      <div className="flex items-center justify-end gap-3">
        {feedback && <FeedbackPill feedback={feedback} />}
        {!apiKey && providerDirty && (
          <SaveButton disabled={saving} saving={saving} onClick={saveProviderOnly}>
            Save provider
          </SaveButton>
        )}
        {apiKey && (
          <button
            type="button"
            onClick={saveKey}
            disabled={saving || apiKey.length < 8}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound className="h-3.5 w-3.5" strokeWidth={2.5} />
            {saving ? 'Saving…' : hasKey ? 'Rotate key' : 'Save key'}
          </button>
        )}
      </div>
    </Section>
  );
}

// ============== Shared bits ==============

const INPUT_CLASS =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm text-neutral-100 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30';
const INPUT_CLASS_DISABLED =
  'w-full cursor-not-allowed rounded-lg border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-sm text-neutral-400';

type Feedback = { kind: 'success' | 'error'; text: string } | null;

function Section({
  title,
  Icon,
  hint,
  children,
}: {
  title: string;
  Icon: LucideIcon;
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
          <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
        </div>
        <h2 className="text-base font-semibold text-neutral-50">{title}</h2>
      </div>
      {hint && (
        <p className="rounded-md border border-neutral-800/80 bg-neutral-900/50 px-3 py-2 text-xs text-neutral-400">
          {hint}
        </p>
      )}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
      </div>
      {children}
      {hint && <div className="mt-1.5 text-[11px] text-neutral-500">{hint}</div>}
    </label>
  );
}

function SaveButton({
  disabled,
  saving,
  onClick,
  children,
}: {
  disabled: boolean;
  saving: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-medium text-neutral-950 shadow-sm shadow-white/10 transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
    >
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />}
      {children}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'bg-neutral-800 text-neutral-50' : 'text-neutral-400 hover:text-neutral-100'
      }`}
    >
      {children}
    </button>
  );
}

function FeedbackPill({ feedback }: { feedback: NonNullable<Feedback> }) {
  const isSuccess = feedback.kind === 'success';
  const Icon = isSuccess ? Check : AlertCircle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
        isSuccess
          ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
          : 'bg-red-500/15 text-red-200 ring-1 ring-red-500/30'
      }`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} />
      {feedback.text}
    </span>
  );
}

// ============== AI TRIAGE CONTROLS ==============
// Drift metric (everyone in the org) + reset / trim actions (owner+admin
// only; the RPC enforces the role check server-side, the UI just hides
// the buttons for non-admins to keep the surface tidy).

interface TriageDrift {
  explored_count: number;
  triaged_count: number;
  override_count: number;
  override_rate: number;
  drift_warning: boolean;
}

function TriageControlsSection({ isAdmin }: { isAdmin: boolean }) {
  const [drift, setDrift] = useState<TriageDrift | null>(null);
  const [signalCount, setSignalCount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmOpen, setConfirmOpen] = useState<null | { action: 'trim' | 'reset' }>(null);

  const refresh = async () => {
    const supabase = createClient();
    const [{ data: driftData }, { count }] = await Promise.all([
      supabase.rpc('triage_drift_for_org'),
      supabase.from('triage_signals').select('id', { count: 'exact', head: true }),
    ]);
    setDrift((driftData as TriageDrift | null) ?? null);
    setSignalCount(count ?? 0);
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
  }, []);

  const performAction = async (action: 'trim' | 'reset') => {
    setBusy(true);
    setFeedback(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc('reset_triage_signals', {
      p_keep_days: action === 'trim' ? 90 : null,
    });
    setBusy(false);
    setConfirmOpen(null);
    if (error) {
      setFeedback({ kind: 'error', text: error.message });
      return;
    }
    setFeedback({
      kind: 'success',
      text: `Removed ${data ?? 0} ${action === 'trim' ? 'signal(s) older than 90 days' : 'signal(s) — model reset to cold start'}.`,
    });
    await refresh();
  };

  return (
    <Section
      title="AI triage learning"
      Icon={Brain}
      hint="The model learns from every triage you do — Fixed, Confirmed real, False positive, Won't fix. The signal stays inside this org and is never used to train anything for another tenant."
    >
      {!loaded && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading model state…
        </div>
      )}

      {loaded && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            <div>
              <div className="text-2xl font-semibold tracking-tight text-neutral-100">
                {signalCount ?? 0}
              </div>
              <div className="text-[10.5px] uppercase tracking-wider text-neutral-500">
                training signals
              </div>
            </div>
            {drift && (
              <>
                <div>
                  <div className="text-2xl font-semibold tracking-tight text-neutral-100">
                    {Math.round((1 - drift.override_rate) * 100)}%
                  </div>
                  <div className="text-[10.5px] uppercase tracking-wider text-neutral-500">
                    auto-dismiss accuracy
                  </div>
                </div>
                <div className="text-[11px] text-neutral-500">
                  Measured against {drift.triaged_count} ε-explored finding
                  {drift.triaged_count === 1 ? '' : 's'} (5% sample of would-have-been
                  auto-dismissed). Of those, you overrode {drift.override_count}.
                </div>
              </>
            )}
          </div>

          {drift?.drift_warning && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-[12px] leading-relaxed text-amber-100">
              <span className="font-medium">Your team's triage patterns may have shifted.</span>{' '}
              The model is being overridden more than 20% of the time on findings it would have
              auto-dismissed. Consider trimming to recent signal only so the model recalibrates
              against your current preferences.
            </div>
          )}

          {!drift && (
            <p className="text-[11.5px] text-neutral-500">
              No drift data yet — once the auto-dismiss policy has surfaced a few findings via
              its 5% ε-greedy sample and you've triaged them, an accuracy estimate appears here.
            </p>
          )}

          {isAdmin && (
            <div className="flex flex-wrap gap-2 border-t border-neutral-800/60 pt-4">
              <button
                type="button"
                onClick={() => setConfirmOpen({ action: 'trim' })}
                disabled={busy || !signalCount}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} />
                Retrain on last 90 days
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen({ action: 'reset' })}
                disabled={busy || !signalCount}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-red-300 ring-1 ring-red-500/30 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                Reset all training data
              </button>
            </div>
          )}

          {feedback && <FeedbackPill feedback={feedback} />}
        </>
      )}

      {confirmOpen && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-4">
          <p className="text-[12.5px] leading-relaxed text-amber-100">
            {confirmOpen.action === 'trim' ? (
              <>
                Trim signals older than 90 days. The model will recalibrate using only your
                team's recent triage. <span className="text-amber-200">This can't be undone.</span>
              </>
            ) : (
              <>
                Reset all {signalCount} training signals. The auto-dismiss model returns to
                cold-start — no findings will be auto-dismissed until your team triages a fresh
                batch.{' '}
                <span className="text-amber-200">This can't be undone.</span>
              </>
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => performAction(confirmOpen.action)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-100 ring-1 ring-amber-400/30 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {confirmOpen.action === 'trim' ? 'Trim signals' : 'Reset model'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(null)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ============== ENGINE FP AUTO-DISMISS POLICY ==============
// Forwarded to Strix as STRIX_FP_AUTO_DISMISS. The engine reads the
// org's feedback.jsonl (authored by our worker on scan start) and uses
// this policy to decide whether to auto-dismiss findings whose
// fingerprint has prior FP labels. Distinct from our wrapper-side KNN
// auto-dismiss (which sets dismissed_by_ai); this drives the engine's
// auto-dismiss path which sets findings.engine_auto_dismissed.

type FpPolicy = 'conservative' | 'aggressive' | 'off';

const FP_POLICIES: { value: FpPolicy; label: string; help: string }[] = [
  {
    value: 'conservative',
    label: 'Conservative (default)',
    help: 'Auto-dismiss only when ≥1 prior FP label and zero TPs for the same fingerprint. Mixed history → surface anyway.',
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    help: 'Auto-dismiss when the latest verdict is FP, regardless of prior TPs. Power-user mode.',
  },
  {
    value: 'off',
    label: 'Off',
    help: 'Never auto-dismiss based on labels. Visibility-only — your team always sees every finding.',
  },
];

function FpAutoDismissSection({ orgId, onSaved }: { orgId: string; onSaved: () => void }) {
  const [policy, setPolicy] = useState<FpPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('organizations')
      .select('fp_auto_dismiss_policy')
      .eq('id', orgId)
      .single()
      .then(({ data }) => {
        const p = (data as { fp_auto_dismiss_policy?: FpPolicy } | null)?.fp_auto_dismiss_policy;
        setPolicy(p ?? 'conservative');
      });
  }, [orgId]);

  const save = async (newPolicy: FpPolicy) => {
    setBusy(true);
    setFeedback(null);
    const supabase = createClient();
    const { error } = await supabase
      .from('organizations')
      .update({ fp_auto_dismiss_policy: newPolicy })
      .eq('id', orgId);
    setBusy(false);
    if (error) {
      setFeedback({ kind: 'error', text: error.message });
      return;
    }
    setPolicy(newPolicy);
    setFeedback({ kind: 'success', text: 'Policy saved.' });
    onSaved();
  };

  return (
    <Section
      title="Engine FP auto-dismiss"
      Icon={Brain}
      hint="The Strix engine reads your team's accumulated triage decisions (feedback.jsonl) and can auto-dismiss findings whose fingerprint has prior FP labels. This policy controls how aggressively it does that. Distinct from the wrapper's own KNN auto-dismiss (which uses cosine similarity over the same labels)."
    >
      {policy === null ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {FP_POLICIES.map((p) => (
              <label
                key={p.value}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
                  policy === p.value
                    ? 'border-cyan-500/40 bg-cyan-500/[0.04]'
                    : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700'
                }`}
              >
                <input
                  type="radio"
                  name="fp_policy"
                  checked={policy === p.value}
                  onChange={() => save(p.value)}
                  disabled={busy}
                  className="mt-0.5 accent-cyan-500"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium text-neutral-200">{p.label}</span>
                  <span className="block text-[11.5px] leading-relaxed text-neutral-500">
                    {p.help}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {feedback && (
            <div className="pt-2">
              <FeedbackPill feedback={feedback} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}
