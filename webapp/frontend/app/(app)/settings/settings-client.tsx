'use client';

import { useState, useTransition } from 'react';
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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
