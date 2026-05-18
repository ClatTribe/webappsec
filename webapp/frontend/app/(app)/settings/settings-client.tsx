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
  Bell,
  ShieldCheck,
  ExternalLink,
  FileLock,
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
    slack_webhook_secret_id: string | null;
    trust_page_enabled?: boolean;
    trust_page_subtitle?: string | null;
    trust_page_published_at?: string | null;
  } | null;
  orgRole: string | null;
}

// Ordered cheapest → most expensive. The first entry is the default
// when an org doesn't set a model. Gemini Flash is ~10× cheaper per
// input token than GPT-5.4 or Claude Sonnet and produces good-enough
// reasoning for the scan agent's typical workload. Power users can
// switch to a heavier model in this dropdown — but defaults matter:
// every free-tier scan runs against the first entry.
const POPULAR_MODELS = [
  { value: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash — default, cheapest' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek — cheap, OSS-friendly' },
  { value: 'gemini/gemini-2.5-pro', label: 'Gemini 2.5 Pro — for deep scans' },
  { value: 'openai/gpt-5.4', label: 'OpenAI GPT-5.4 — premium' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Anthropic Claude Sonnet 4.6 — premium' },
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

      {/* Threat-intel & recon API keys (§19.1 Tier 1 item 10).
          5 STRIX_* env vars unlock engine-side recon tools. Same vault
          pattern as the LLM key — secret value lives in vault.secrets,
          this UI only sets/clears the secret_id pointer in org_secrets. */}
      {org && (orgRole === 'owner' || orgRole === 'admin') && (
        <ApiKeysSection orgId={org.id} />
      )}

      {/* Slack notifications (Tier A / migration 037). Vault-encrypted
          incoming-webhook URL; the worker decrypts at scan-finish and
          posts a small block-kit message with severity counts + a deep-
          link back to the scan page. */}
      {org && (orgRole === 'owner' || orgRole === 'admin') && (
        <SlackWebhookSection
          orgId={org.id}
          initiallySet={Boolean(org.slack_webhook_secret_id)}
          onSaved={() => router.refresh()}
        />
      )}

      {/* Public Trust Page (migration 047). Owner-only toggle —
          prospect-facing URL with compliance posture + recent
          improvements. The vibe-coded founder's answer to
          "are you SOC 2 ready?". */}
      {org && isOwner && (
        <TrustPageSection
          orgId={org.id}
          orgSlug={org.slug}
          initiallyEnabled={Boolean(org.trust_page_enabled)}
          initialSubtitle={org.trust_page_subtitle ?? ''}
          publishedAt={org.trust_page_published_at ?? null}
          onSaved={() => router.refresh()}
        />
      )}

      {/* Auditor share-links (migration 054). Admin-only. Time-bounded
          anonymous URLs into the deeper evidence than the public trust
          page. */}
      {org && (orgRole === 'owner' || orgRole === 'admin') && (
        <AuditLinksSection orgId={org.id} />
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
      hint="TensorShield uses LiteLLM under the hood. Pick any LiteLLM-supported provider; the API key is stored in an encrypted vault and only decrypted server-side at scan time."
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
      hint="The TensorShield engine reads your team's accumulated triage decisions (feedback.jsonl) and can auto-dismiss findings whose fingerprint has prior FP labels. This policy controls how aggressively it does that. Distinct from the wrapper's own KNN auto-dismiss (which uses cosine similarity over the same labels)."
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

// ============== THREAT-INTEL & RECON API KEYS ==============
// 5 STRIX_* env vars (wishlist §5). Each unlocks a specific engine recon
// capability. Stored vault-encrypted; values never leave the worker.
// Owner/admin-gated server-side via the API route + RLS.

const STRIX_KEYS: Array<{
  name:
    | 'STRIX_GITHUB_TOKEN'
    | 'STRIX_BING_KEY'
    | 'STRIX_SECURITYTRAILS_KEY'
    | 'STRIX_VIRUSTOTAL_KEY'
    | 'STRIX_VIEWDNS_KEY';
  label: string;
  unlocks: string;
  freeTier: string;
  signupUrl: string;
}> = [
  {
    name: 'STRIX_GITHUB_TOKEN',
    label: 'GitHub PAT',
    unlocks: 'Code-search recon (GitHub & GitLab) + secret-leak detection',
    freeTier: 'Free — any GitHub PAT, no scopes needed',
    signupUrl: 'https://github.com/settings/tokens?type=beta',
  },
  {
    name: 'STRIX_BING_KEY',
    label: 'Bing Web Search API',
    unlocks: 'SaaS leak discovery (Trello / Notion / Pastebin / Confluence)',
    freeTier: '1k queries/month free',
    signupUrl: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api',
  },
  {
    name: 'STRIX_SECURITYTRAILS_KEY',
    label: 'SecurityTrails',
    unlocks: 'Passive DNS history (preferred source)',
    freeTier: 'Limited free tier',
    signupUrl: 'https://securitytrails.com/corp/api',
  },
  {
    name: 'STRIX_VIRUSTOTAL_KEY',
    label: 'VirusTotal',
    unlocks: 'Passive DNS history (fallback)',
    freeTier: 'Limited free tier',
    signupUrl: 'https://www.virustotal.com/gui/my-apikey',
  },
  {
    name: 'STRIX_VIEWDNS_KEY',
    label: 'ViewDNS',
    unlocks: 'Reverse-IP secondary',
    freeTier: 'Free tier exists',
    signupUrl: 'https://viewdns.info/api',
  },
];

interface OrgSecretRow {
  key: string;
  set_at: string;
}

function ApiKeysSection({ orgId }: { orgId: string }) {
  const [setKeys, setSetKeys] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const supabase = createClient();
    const { data } = await supabase.from('org_secrets').select('key, set_at').eq('org_id', orgId);
    const map: Record<string, string> = {};
    for (const row of (data as OrgSecretRow[] | null) ?? []) {
      map[row.key] = row.set_at;
    }
    setSetKeys(map);
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
  }, [orgId]);

  return (
    <Section
      title="Threat-intel & recon API keys"
      Icon={KeyRound}
      hint={
        'TensorShield uses these to enrich domain scans with code-search, SaaS-leak discovery, ' +
        "passive DNS history, and reverse-IP recon. Each is optional — without a key, the " +
        'corresponding tool fails open silently. Values are stored vault-encrypted and only ' +
        'decrypted in the worker at scan time.'
      }
    >
      {!loaded ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {STRIX_KEYS.map((k) => (
            <ApiKeyRow
              key={k.name}
              meta={k}
              isSet={!!setKeys[k.name]}
              setAt={setKeys[k.name]}
              orgId={orgId}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function ApiKeyRow({
  meta,
  isSet,
  setAt,
  orgId,
  onChanged,
}: {
  meta: (typeof STRIX_KEYS)[number];
  isSet: boolean;
  setAt: string | undefined;
  orgId: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = async () => {
    if (value.trim().length < 8) {
      setFeedback({ kind: 'error', text: 'Key looks too short.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: meta.name, value: value.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Save failed' });
      return;
    }
    setValue('');
    setEditing(false);
    setFeedback({ kind: 'success', text: 'Saved.' });
    onChanged();
  };

  const clear = async () => {
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/secrets`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: meta.name }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Clear failed' });
      return;
    }
    setFeedback({ kind: 'success', text: 'Cleared.' });
    onChanged();
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-neutral-100">{meta.label}</span>
            <code className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 ring-1 ring-neutral-800">
              {meta.name}
            </code>
            {isSet ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-200 ring-1 ring-emerald-400/30">
                <Check className="h-3 w-3" strokeWidth={2.5} />
                Set
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-neutral-800/60 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-400 ring-1 ring-neutral-700/40">
                Not set
              </span>
            )}
          </div>
          <div className="text-[12px] text-neutral-400">{meta.unlocks}</div>
          <div className="flex items-center gap-3 text-[10.5px] text-neutral-500">
            <span>{meta.freeTier}</span>
            <a
              href={meta.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-300/80 transition-colors hover:text-cyan-300 hover:underline"
            >
              Get a key →
            </a>
            {isSet && setAt && (
              <span>Saved {new Date(setAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-1.5">
          {!editing ? (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-200 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800 disabled:opacity-50"
              >
                {isSet ? 'Update' : 'Set'}
              </button>
              {isSet && (
                <button
                  type="button"
                  onClick={clear}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-red-300 ring-1 ring-red-500/30 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2.5} />
                  Clear
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setValue('');
                setFeedback(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-300 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${meta.label}…`}
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-100 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 transition-colors hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </button>
        </div>
      )}

      {feedback && (
        <div className="mt-2">
          <FeedbackPill feedback={feedback} />
        </div>
      )}
    </div>
  );
}

// ============== SLACK WEBHOOK ==============
//
// Tier A — async push notification channel. The worker decrypts the
// stored webhook URL via worker_decrypt_org_slack_webhook(p_scan_id)
// (migration 037) at scan-finalise time and POSTs a small block-kit
// summary message. Empty / unset means the worker doesn't notify
// anyone — the wrapper never falls back to a "default" webhook.

function SlackWebhookSection({
  orgId,
  initiallySet,
  onSaved,
}: {
  orgId: string;
  initiallySet: boolean;
  onSaved: () => void;
}) {
  const [isSet, setIsSet] = useState(initiallySet);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const save = async () => {
    if (!url.trim().startsWith('https://hooks.slack.com/services/')) {
      setFeedback({
        kind: 'error',
        text: 'Must be a Slack incoming-webhook URL (starts with https://hooks.slack.com/services/).',
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/slack-webhook`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Save failed' });
      return;
    }
    setUrl('');
    setIsSet(true);
    setEditing(false);
    setFeedback({ kind: 'success', text: 'Webhook saved.' });
    onSaved();
  };

  const clear = async () => {
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/slack-webhook`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Clear failed' });
      return;
    }
    setIsSet(false);
    setFeedback({ kind: 'success', text: 'Webhook cleared.' });
    onSaved();
  };

  return (
    <Section
      title="Slack notifications"
      Icon={Bell}
      hint={
        'Get a one-line summary in Slack when a scan finishes — '
        + 'severity counts, total cost, and a click-through to the '
        + 'scan page. Webhook URLs are stored vault-encrypted and only '
        + 'decrypted in the worker at scan-completion time.'
      }
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-neutral-100">
                Incoming webhook URL
              </span>
              {isSet ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-200 ring-1 ring-emerald-400/30">
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                  Configured
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-md bg-neutral-800/60 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-400 ring-1 ring-neutral-700/40">
                  Not configured
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500">
              Create one at <a
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-300/80 hover:text-cyan-300 hover:underline"
              >Slack → Incoming Webhooks</a>{' '}
              and paste the resulting URL.
            </p>
          </div>
          <div className="flex flex-shrink-0 gap-1.5">
            {!editing ? (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-200 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                >
                  {isSet ? 'Update' : 'Set'}
                </button>
                {isSet && (
                  <button
                    type="button"
                    onClick={clear}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-red-300 ring-1 ring-red-500/30 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={2.5} />
                    Clear
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setUrl('');
                  setFeedback(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-300 ring-1 ring-neutral-800 transition-colors hover:bg-neutral-800"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {editing && (
          <div className="mt-3 flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T.../B.../..."
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-100 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 ring-1 ring-cyan-400/30 transition-colors hover:bg-cyan-500/25 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Save
            </button>
          </div>
        )}

        {feedback && (
          <div className="mt-2">
            <FeedbackPill feedback={feedback} />
          </div>
        )}
      </div>
    </Section>
  );
}

// ============== TRUST PAGE ==============
// Owner-only opt-in for the public /trust/<slug> route (migration 047).
// Flips organizations.trust_page_enabled and stores an optional
// public-facing tagline. The page itself is gated by get_trust_page_payload
// — the function returns null for unknown slugs or orgs with the flag
// off, so this toggle is the security boundary, not the URL pattern.

function TrustPageSection({
  orgId,
  orgSlug,
  initiallyEnabled,
  initialSubtitle,
  publishedAt,
  onSaved,
}: {
  orgId: string;
  orgSlug: string;
  initiallyEnabled: boolean;
  initialSubtitle: string;
  publishedAt: string | null;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [subtitle, setSubtitle] = useState(initialSubtitle);
  const [savedSubtitle, setSavedSubtitle] = useState(initialSubtitle);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const subtitleDirty = subtitle.trim() !== (savedSubtitle ?? '').trim();
  const subtitleTooLong = subtitle.length > 280;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const trustUrl = `${origin}/trust/${orgSlug}`;

  async function toggleEnabled(next: boolean) {
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/trust-page`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Save failed' });
      return;
    }
    setEnabled(next);
    setFeedback({
      kind: 'success',
      text: next ? 'Trust page is live.' : 'Trust page disabled.',
    });
    onSaved();
  }

  async function saveSubtitle() {
    if (!subtitleDirty || subtitleTooLong) return;
    setBusy(true);
    setFeedback(null);
    const res = await fetch(`/api/orgs/${orgId}/trust-page`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: subtitle.trim() || null }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Save failed' });
      return;
    }
    setSavedSubtitle(subtitle.trim());
    setFeedback({ kind: 'success', text: 'Tagline saved.' });
    onSaved();
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(trustUrl);
      setFeedback({ kind: 'success', text: 'URL copied.' });
    } catch {
      setFeedback({ kind: 'error', text: 'Copy failed — long-press to copy.' });
    }
  }

  return (
    <Section
      title="Public Trust Page"
      Icon={ShieldCheck}
      hint={
        'A public URL prospects and auditors can bookmark. Shows your '
        + 'compliance status, recent improvements, and a tamper-evident '
        + 'audit trail. Updates after every scan. The toggle below '
        + 'controls whether the URL is live — disabled means it returns 404.'
      }
    >
      <div className="space-y-4">
        {/* Enable toggle */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-100">
                  Trust page status
                </span>
                {enabled ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-200 ring-1 ring-emerald-400/30">
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                    Live
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md bg-neutral-800/60 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-400 ring-1 ring-neutral-700/40">
                    Off
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-500">
                {enabled
                  ? 'Anyone with the URL can view your compliance status and recent improvements. Disable to take it offline.'
                  : 'Page is private. Enable to share the URL with a prospect or auditor.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => toggleEnabled(!enabled)}
              disabled={busy}
              className={`flex-shrink-0 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all disabled:opacity-50 ${
                enabled
                  ? 'border border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
                  : 'bg-gradient-to-b from-white to-neutral-200 text-neutral-950 shadow-md shadow-white/10 hover:shadow-lg'
              }`}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : enabled ? (
                'Disable'
              ) : (
                'Enable'
              )}
            </button>
          </div>
        </div>

        {/* URL row */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="text-sm font-medium text-neutral-100">Your URL</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[12.5px] text-cyan-300 break-all">
              {trustUrl}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              className="rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Copy
            </button>
            {enabled && (
              <a
                href={trustUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20"
              >
                Open
                <ExternalLink className="h-3 w-3" strokeWidth={2.5} />
              </a>
            )}
          </div>
          {publishedAt && (
            <p className="mt-2 text-[10.5px] text-neutral-500">
              First enabled {new Date(publishedAt).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Subtitle */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <label className="text-sm font-medium text-neutral-100">
            Tagline (optional)
          </label>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500">
            One line rendered under your org name on the trust page.
            E.g. &quot;A SaaS for college applications · SOC 2 in progress&quot;.
          </p>
          <textarea
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            rows={2}
            maxLength={320}
            placeholder="A short, prospect-friendly line about what your company does."
            className="mt-2 w-full resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-neutral-600"
          />
          <div className="mt-2 flex items-center justify-between">
            <span
              className={`text-[10.5px] ${
                subtitleTooLong ? 'text-rose-300' : 'text-neutral-500'
              }`}
            >
              {subtitle.length}/280
            </span>
            <button
              type="button"
              onClick={saveSubtitle}
              disabled={busy || !subtitleDirty || subtitleTooLong}
              className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 shadow-sm transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save tagline'}
            </button>
          </div>
        </div>

        {feedback && (
          <p
            className={`text-xs ${
              feedback.kind === 'success' ? 'text-emerald-300' : 'text-rose-300'
            }`}
          >
            {feedback.text}
          </p>
        )}
      </div>
    </Section>
  );
}

// ============== AUDIT SHARE-LINKS ==============
// Admin-only manager for time-bounded auditor URLs (migration 054).
// Token is returned exactly once at creation — never re-exposed on
// subsequent reads. Listed links show prefix + expiry + access count
// so the admin can identify and revoke each one.

interface AuditLink {
  id: string;
  label: string | null;
  token_preview: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

interface NewLinkResult {
  id: string;
  token: string;
  label: string | null;
  expires_at: string;
  created_at: string;
}

function AuditLinksSection({ orgId }: { orgId: string }) {
  const [links, setLinks] = useState<AuditLink[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [newLink, setNewLink] = useState<NewLinkResult | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [ttlDays, setTtlDays] = useState<number>(30);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/audit-links`);
      if (res.ok) {
        const body = (await res.json()) as { links: AuditLink[] };
        setLinks(body.links);
      } else {
        setLinks([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    setBusy(true);
    setFeedback(null);
    setNewLink(null);
    const res = await fetch(`/api/orgs/${orgId}/audit-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || null, ttl_days: ttlDays }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Create failed' });
      return;
    }
    const body = (await res.json()) as NewLinkResult;
    setNewLink(body);
    setLabel('');
    setShowCreate(false);
    void refresh();
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this auditor link? Anyone holding the URL will get a 404 immediately.')) {
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/orgs/${orgId}/audit-links?id=${id}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ kind: 'error', text: body.error ?? 'Revoke failed' });
      return;
    }
    void refresh();
  }

  async function copyNewLink() {
    if (!newLink) return;
    const url = `${window.location.origin}/audit/${newLink.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setFeedback({ kind: 'success', text: 'URL copied.' });
    } catch {
      setFeedback({ kind: 'error', text: 'Copy failed — long-press to copy.' });
    }
  }

  const active = (links ?? []).filter((l) => !l.revoked_at && new Date(l.expires_at) > new Date());
  const inactive = (links ?? []).filter((l) => l.revoked_at || new Date(l.expires_at) <= new Date());

  return (
    <Section
      title="Auditor share-links"
      Icon={FileLock}
      hint={
        'Time-bounded anonymous URLs into deeper compliance evidence than '
        + 'the public trust page (raw control verdicts, recent findings, '
        + 'signed evidence chain). Auditors use these during a SOC 2 / '
        + 'ISO 27001 review. Each access is logged.'
      }
    >
      {/* Just-created link banner — token is the secret, shown ONCE. */}
      {newLink && (
        <div className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-200">
            <Check className="h-4 w-4" strokeWidth={2.5} />
            Link created — copy this URL now. We can&apos;t show it again.
          </div>
          <code className="mt-3 block break-all rounded-md border border-emerald-500/30 bg-neutral-950 px-3 py-2 font-mono text-xs text-emerald-200">
            {typeof window !== 'undefined' ? window.location.origin : ''}
            /audit/{newLink.token}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyNewLink}
              className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
            >
              Copy URL
            </button>
            <button
              type="button"
              onClick={() => setNewLink(null)}
              className="rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {!showCreate ? (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="mb-4 rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-2 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md"
        >
          Generate new link
        </button>
      ) : (
        <div className="mb-4 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <Field label="Label (optional)" hint="Helps you remember which auditor this link is for.">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Acme Corp · SOC 2 Type 2 audit, May 2026"
              maxLength={200}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Expires in" hint="Auditors typically need ~30 days. Max 365.">
            <select
              value={ttlDays}
              onChange={(e) => setTtlDays(parseInt(e.target.value, 10))}
              className={INPUT_CLASS}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
          </Field>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="rounded-md bg-gradient-to-b from-white to-neutral-200 px-3.5 py-1.5 text-xs font-semibold text-neutral-950 shadow-sm hover:shadow-md disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Active links */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Active links ({active.length})
        </h3>
        {loading && (
          <p className="text-xs text-neutral-500">
            <Loader2 className="inline h-3 w-3 animate-spin" /> Loading…
          </p>
        )}
        {!loading && active.length === 0 && (
          <p className="text-xs text-neutral-500">No active auditor links.</p>
        )}
        {active.map((l) => (
          <LinkRow key={l.id} link={l} onRevoke={() => revoke(l.id)} />
        ))}
      </div>

      {/* Inactive (revoked or expired) */}
      {inactive.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
            Revoked / expired ({inactive.length})
          </summary>
          <div className="mt-2 space-y-2">
            {inactive.map((l) => (
              <LinkRow key={l.id} link={l} inactive />
            ))}
          </div>
        </details>
      )}

      {feedback && (
        <p
          className={`mt-3 text-xs ${
            feedback.kind === 'success' ? 'text-emerald-300' : 'text-rose-300'
          }`}
        >
          {feedback.text}
        </p>
      )}
    </Section>
  );
}

function LinkRow({
  link,
  onRevoke,
  inactive,
}: {
  link: AuditLink;
  onRevoke?: () => void;
  inactive?: boolean;
}) {
  const expires = new Date(link.expires_at);
  const expired = expires <= new Date();
  const revoked = Boolean(link.revoked_at);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-neutral-100">{link.label || '(no label)'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-neutral-500">
            <code className="font-mono text-neutral-400">{link.token_preview}</code>
            <span>
              {revoked
                ? `Revoked ${new Date(link.revoked_at!).toLocaleDateString()}`
                : expired
                ? 'Expired'
                : `Expires ${expires.toLocaleDateString()}`}
            </span>
            <span>· {link.access_count} access{link.access_count === 1 ? '' : 'es'}</span>
            {link.last_accessed_at && (
              <span>· last {new Date(link.last_accessed_at).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        {!inactive && onRevoke && (
          <button
            type="button"
            onClick={onRevoke}
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20"
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}
