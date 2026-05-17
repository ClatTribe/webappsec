'use client';

import { useState } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Edit3,
  Power,
  Check,
  X as XIcon,
  AlertCircle,
} from 'lucide-react';
import { SUGGESTED_LANGUAGES, validateRuleYaml } from '@/lib/custom-rules';

interface CustomRuleRow {
  id: string;
  name: string;
  description: string | null;
  language: string;
  severity: string;
  cwe: string | null;
  enabled: boolean;
  rule_hash: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface Props {
  initialRules: CustomRuleRow[];
}

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
  high: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
  medium: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  low: 'bg-lime-500/15 text-lime-200 ring-lime-400/30',
  info: 'bg-neutral-700/40 text-neutral-200 ring-neutral-600/40',
};

const STARTER_YAML = `rules:
  - id: my-custom-rule
    pattern: |
      # describe the pattern you want to detect
      eval(...)
    message: |
      eval() is forbidden in our codebase — use JSON.parse instead.
    languages: [javascript, typescript]
    severity: ERROR`;

export default function CustomRulesClient({ initialRules }: Props) {
  const [rules, setRules] = useState<CustomRuleRow[]>(initialRules);
  const [editing, setEditing] = useState<CustomRuleRow | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleSaved = (saved: CustomRuleRow) => {
    setRules((prev) => {
      const i = prev.findIndex((r) => r.id === saved.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = saved;
        return next;
      }
      return [saved, ...prev];
    });
    setEditing(null);
  };

  const toggle = async (rule: CustomRuleRow) => {
    setErr(null);
    try {
      const res = await fetch(`/api/custom-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    }
  };

  const archive = async (rule: CustomRuleRow) => {
    if (!confirm(`Archive rule "${rule.name}"? Past findings stay; new scans won't run it.`))
      return;
    setErr(null);
    try {
      const res = await fetch(`/api/custom-rules/${rule.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json();
        setErr(j?.error ?? `failed (${res.status})`);
        return;
      }
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div>
          <h2 className="text-sm font-medium">Active rules</h2>
          <p className="mt-0.5 text-[11.5px] text-neutral-500">
            {rules.filter((r) => r.enabled).length} enabled · {rules.length} total
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New rule
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {err}
        </div>
      )}

      <ul className="space-y-2">
        {rules.length === 0 ? (
          <li className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-6 text-center text-[12px] text-neutral-500">
            No custom rules yet. Author one to surface patterns specific to your stack.
          </li>
        ) : (
          rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onEdit={() => setEditing(r)}
              onToggle={() => toggle(r)}
              onArchive={() => archive(r)}
            />
          ))
        )}
      </ul>

      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

function RuleRow({
  rule,
  onEdit,
  onToggle,
  onArchive,
}: {
  rule: CustomRuleRow;
  onEdit: () => void;
  onToggle: () => void;
  onArchive: () => void;
}) {
  return (
    <li
      className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${
        rule.enabled
          ? 'border-neutral-800/80 bg-neutral-900/30'
          : 'border-neutral-800/40 bg-neutral-900/15 opacity-70'
      }`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-medium text-neutral-100">{rule.name}</span>
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${SEVERITY_TONE[rule.severity] ?? SEVERITY_TONE.info}`}
          >
            {rule.severity}
          </span>
          <span className="rounded-md bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            {rule.language}
          </span>
          {rule.cwe && (
            <span className="rounded-md bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
              {rule.cwe}
            </span>
          )}
          {!rule.enabled && (
            <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
              disabled
            </span>
          )}
        </div>
        {rule.description && (
          <p className="text-[11.5px] leading-relaxed text-neutral-400">{rule.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-neutral-500">
          <span>created {new Date(rule.created_at).toLocaleDateString()}</span>
          {rule.last_used_at ? (
            <span>last fired {new Date(rule.last_used_at).toLocaleDateString()}</span>
          ) : (
            <span>never used yet</span>
          )}
          <span className="font-mono text-[10px] text-neutral-600">
            {rule.rule_hash.slice(0, 12)}
          </span>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-[10.5px] text-neutral-200 hover:bg-neutral-700"
        >
          <Edit3 className="h-3 w-3" strokeWidth={2.25} />
          Edit
        </button>
        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] ring-1 ${
            rule.enabled
              ? 'bg-amber-500/10 text-amber-200 ring-amber-400/30 hover:bg-amber-500/20'
              : 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30 hover:bg-emerald-500/25'
          }`}
        >
          <Power className="h-3 w-3" strokeWidth={2.25} />
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={onArchive}
          className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-2 py-1 text-[10.5px] text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/20"
        >
          <Trash2 className="h-3 w-3" strokeWidth={2.25} />
          Archive
        </button>
      </div>
    </li>
  );
}

function RuleEditor({
  rule,
  onClose,
  onSaved,
}: {
  rule: CustomRuleRow | null;
  onClose: () => void;
  onSaved: (saved: CustomRuleRow) => void;
}) {
  const isNew = rule === null;
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [language, setLanguage] = useState(rule?.language ?? 'python');
  const [severity, setSeverity] = useState<string>(rule?.severity ?? 'medium');
  const [cwe, setCwe] = useState(rule?.cwe ?? '');
  // We don't pre-fill rule_yaml on edit because the API doesn't
  // include it in the list; user is editing metadata only OR re-pasting
  // a new body intentionally.
  const [ruleYaml, setRuleYaml] = useState(isNew ? STARTER_YAML : '');
  const [yamlEdited, setYamlEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const validation = yamlEdited || isNew ? validateRuleYaml(ruleYaml) : { ok: true };

  const submit = async () => {
    if (submitting) return;
    if (!name.trim() || !language.trim()) {
      setErr('name + language required');
      return;
    }
    if ((isNew || yamlEdited) && !validation.ok) {
      setErr(validation.error ?? 'invalid rule YAML');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        language: language.trim().toLowerCase(),
        severity,
        cwe: cwe.trim() || null,
      };
      if (isNew || yamlEdited) body.rule_yaml = ruleYaml;

      const url = isNew ? '/api/custom-rules' : `/api/custom-rules/${rule!.id}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      onSaved(json.rule as CustomRuleRow);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{isNew ? 'New custom rule' : 'Edit rule'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <XIcon className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="forbid-eval-in-prod"
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100"
              />
            </Field>
            <Field label="Language">
              <input
                type="text"
                list="custom-rule-language-suggestions"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                maxLength={50}
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100"
              />
              <datalist id="custom-rule-language-suggestions">
                {SUGGESTED_LANGUAGES.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
          </div>

          <Field label="Description (optional)">
            <textarea
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2048}
              placeholder="One-line context: why this rule exists, who owns it."
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Severity">
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100"
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="CWE (optional)">
              <input
                type="text"
                value={cwe ?? ''}
                onChange={(e) => setCwe(e.target.value)}
                maxLength={50}
                placeholder="CWE-95"
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100"
              />
            </Field>
          </div>

          <Field
            label={
              <>
                Rule YAML (Semgrep format){' '}
                {!isNew && !yamlEdited && (
                  <span className="text-neutral-500">
                    — leave blank to keep current
                  </span>
                )}
              </>
            }
          >
            <textarea
              value={ruleYaml}
              onChange={(e) => {
                setRuleYaml(e.target.value);
                setYamlEdited(true);
              }}
              onFocus={() => {
                if (!isNew && !yamlEdited) setRuleYaml(STARTER_YAML);
              }}
              rows={14}
              maxLength={65536}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100"
            />
            {(isNew || yamlEdited) && (
              <div className="mt-1 flex items-center gap-1.5 text-[10.5px]">
                {validation.ok ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-300" strokeWidth={2.5} />
                    <span className="text-emerald-300">
                      Looks valid · {validation.rule_count} rule
                      {(validation.rule_count ?? 1) === 1 ? '' : 's'} detected
                    </span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-3 w-3 text-rose-300" strokeWidth={2.5} />
                    <span className="text-rose-300">{validation.error}</span>
                  </>
                )}
              </div>
            )}
          </Field>

          {err && <div className="text-[11.5px] text-rose-300">{err}</div>}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-[11.5px] text-neutral-500 hover:text-neutral-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !name.trim() || ((isNew || yamlEdited) && !validation.ok)}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-500/15 px-3 py-1.5 text-[12px] font-medium text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-500/25 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />}
              {isNew ? 'Create rule' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
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
