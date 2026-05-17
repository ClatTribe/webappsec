'use client';

import { useState } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Calendar,
  Layers,
} from 'lucide-react';
import type { CompensatingControl, ControlMappingRow } from '@/lib/supabase/types';

// Tier II #13 — compensating controls client.
//
// Three modes inside one page:
//   - List active controls (received from the server)
//   - "+ New" → modal to declare a compensating control
//   - Inline cross-framework chips: when a row's (framework, control_id)
//     is in control_mappings, we show "also covers SOC 2 CC6.1, PCI 8.4"
//     so the user can see the leverage at a glance.

const FRAMEWORK_LABEL: Record<string, string> = {
  soc_2: 'SOC 2',
  iso_27001: 'ISO 27001',
  pci_dss: 'PCI DSS 4.0',
  hipaa: 'HIPAA',
  nist_800_53: 'NIST 800-53',
  gdpr: 'GDPR',
  fedramp_high: 'FedRAMP High',
  csa_caiq: 'CSA CAIQ',
  owasp_asvs: 'OWASP ASVS',
};

interface Props {
  initialControls: CompensatingControl[];
}

export default function CompensatingClient({ initialControls }: Props) {
  const [controls, setControls] = useState<CompensatingControl[]>(initialControls);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleCreated = (c: CompensatingControl) => {
    setControls((prev) => [c, ...prev]);
    setShowForm(false);
  };

  const handleRevoke = async (id: string) => {
    const reason = window.prompt('Revocation reason (optional, auditor-visible):') ?? '';
    if (reason === null) return; // user pressed cancel
    setErr(null);
    try {
      const res = await fetch(`/api/compensating-controls/${id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (!res.ok) {
        const json = await res.json();
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      setControls((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-4">
        <div>
          <h2 className="text-sm font-medium">Active controls</h2>
          <p className="mt-0.5 text-[11.5px] text-neutral-500">
            {controls.length} active &middot; auditor-visible on your trust page
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setErr(null);
            setShowForm(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/25"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New compensating control
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {err}
        </div>
      )}

      <ul className="space-y-2">
        {controls.length === 0 ? (
          <li className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/20 px-4 py-6 text-center text-[12px] text-neutral-500">
            No compensating controls declared yet. Mitigate a failing control to
            unlock partial credit on your audit-readiness score.
          </li>
        ) : (
          controls.map((c) => (
            <ControlRow key={c.id} control={c} onRevoke={() => handleRevoke(c.id)} />
          ))
        )}
      </ul>

      {showForm && (
        <CreateForm
          onClose={() => setShowForm(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

function ControlRow({
  control,
  onRevoke,
}: {
  control: CompensatingControl;
  onRevoke: () => void;
}) {
  const [equiv, setEquiv] = useState<ControlMappingRow[] | null>(null);
  const [equivLoaded, setEquivLoaded] = useState(false);

  const loadEquivalents = async () => {
    if (equivLoaded) return;
    setEquivLoaded(true);
    try {
      const res = await fetch(
        `/api/control-mappings/${encodeURIComponent(control.framework)}/${encodeURIComponent(control.control_id)}`,
      );
      if (!res.ok) return;
      const json = await res.json();
      setEquiv((json.mappings ?? []) as ControlMappingRow[]);
    } catch {
      // Best-effort; mapping is decorative.
    }
  };

  // Eagerly load on first render — keeps the row complete on first
  // paint without the user having to expand anything.
  if (!equivLoaded) {
    void loadEquivalents();
  }

  const expiresInDays =
    control.expires_at !== null
      ? Math.floor((new Date(control.expires_at).getTime() - Date.now()) / 86_400_000)
      : null;

  return (
    <li className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="rounded-md bg-neutral-800/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-200">
              {FRAMEWORK_LABEL[control.framework] ?? control.framework}
            </span>
            <span className="font-mono text-[11.5px] text-amber-200">{control.control_id}</span>
            {control.review_due_soon && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-400/30">
                <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
                review due soon
              </span>
            )}
          </div>
          <div className="mt-1 text-[13px] font-medium text-neutral-100">{control.title}</div>
        </div>
        <button
          type="button"
          onClick={onRevoke}
          className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-2 py-1 text-[10.5px] text-rose-200 ring-1 ring-rose-400/30 hover:bg-rose-500/20"
          title="Revoke (soft delete; audit trail preserved)"
        >
          <Trash2 className="h-3 w-3" strokeWidth={2.25} />
          Revoke
        </button>
      </div>

      <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-neutral-300">
        {control.rationale}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-neutral-500">
        <span className="inline-flex items-center gap-1">
          <Calendar className="h-2.5 w-2.5" strokeWidth={2.5} />
          effective {new Date(control.effective_from).toLocaleDateString()}
        </span>
        {control.expires_at && (
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-2.5 w-2.5" strokeWidth={2.5} />
            expires {new Date(control.expires_at).toLocaleDateString()}
            {expiresInDays !== null && expiresInDays >= 0 && (
              <span className="text-neutral-600">({expiresInDays}d)</span>
            )}
          </span>
        )}
      </div>

      {control.evidence_links.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Evidence
          </div>
          <ul className="space-y-0.5">
            {control.evidence_links.map((url) => (
              <li key={url} className="text-[11px]">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-cyan-300/90 underline-offset-2 hover:text-cyan-200 hover:underline"
                >
                  <ExternalLink className="h-2.5 w-2.5" strokeWidth={2.5} />
                  {truncate(url, 80)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cross-framework chips — what other frameworks this control
          covers. Loaded eagerly above. */}
      {equiv && equiv.length > 1 && (
        <div className="space-y-1 border-t border-amber-500/10 pt-2">
          <div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-200/80">
            <Layers className="h-2.5 w-2.5" strokeWidth={2.5} />
            Also covers
          </div>
          <div className="flex flex-wrap gap-1.5">
            {equiv
              .filter(
                (e) => !(e.framework === control.framework && e.control_id === control.control_id),
              )
              .map((e) => (
                <span
                  key={`${e.framework}:${e.control_id}`}
                  className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-200"
                  title={e.control_label ?? ''}
                >
                  <span className="font-semibold">{FRAMEWORK_LABEL[e.framework] ?? e.framework}</span>{' '}
                  <span className="font-mono">{e.control_id}</span>
                </span>
              ))}
          </div>
        </div>
      )}
    </li>
  );
}

// ============== Create form modal ===================================

function CreateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: CompensatingControl) => void;
}) {
  const [framework, setFramework] = useState('soc_2');
  const [controlId, setControlId] = useState('');
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [evidenceLinks, setEvidenceLinks] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [equiv, setEquiv] = useState<ControlMappingRow[] | null>(null);

  // Look up cross-framework equivalents as the user types the
  // control_id — shows what other frameworks the same control covers
  // *before* they submit. Helps them realise "this compensation
  // actually covers 5 frameworks, not 1."
  const onControlIdBlur = async () => {
    if (!framework || !controlId.trim()) {
      setEquiv(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/control-mappings/${encodeURIComponent(framework)}/${encodeURIComponent(controlId.trim())}`,
      );
      if (!res.ok) {
        setEquiv([]);
        return;
      }
      const json = await res.json();
      setEquiv((json.mappings ?? []) as ControlMappingRow[]);
    } catch {
      setEquiv([]);
    }
  };

  const submit = async () => {
    if (!framework || !controlId.trim() || !title.trim() || !rationale.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const links = evidenceLinks
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch('/api/compensating-controls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          framework,
          control_id: controlId.trim(),
          title: title.trim(),
          rationale: rationale.trim(),
          evidence_links: links,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? `failed (${res.status})`);
        return;
      }
      onCreated(json.control as CompensatingControl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg space-y-3 rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="text-lg font-semibold">Declare compensating control</h2>
        <p className="text-[11.5px] text-neutral-500">
          Document the mitigation your auditor accepted for a failing control.
          Required: framework, control id, title, rationale. Evidence links and
          expiry are optional but recommended.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Framework">
            <select
              value={framework}
              onChange={(e) => {
                setFramework(e.target.value);
                setEquiv(null);
              }}
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100"
            >
              {Object.entries(FRAMEWORK_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Control ID">
            <input
              type="text"
              value={controlId}
              onChange={(e) => setControlId(e.target.value)}
              onBlur={onControlIdBlur}
              placeholder="e.g. CC6.1"
              maxLength={50}
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 font-mono text-[12px] text-neutral-100 placeholder:text-neutral-600"
            />
          </Field>
        </div>

        {equiv && equiv.length > 1 && (
          <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-1.5 text-[10.5px] text-amber-200">
            <strong>Also satisfies:</strong>{' '}
            {equiv
              .filter((e) => !(e.framework === framework && e.control_id === controlId.trim()))
              .map((e) => `${FRAMEWORK_LABEL[e.framework] ?? e.framework} ${e.control_id}`)
              .join(' · ')}
          </div>
        )}

        <Field label="Title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="WAF rule R-1234 + bastion-only admin access"
            maxLength={200}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600"
          />
        </Field>

        <Field label="Rationale (auditor-visible)">
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Direct MFA can't be enforced for legacy SAML IdP. Compensating measure: WAF rule R-1234 blocks any session not originating from the bastion host network. Bastion enforces hardware MFA. Reviewed quarterly."
            rows={4}
            maxLength={8192}
            className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600"
          />
        </Field>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Evidence links (one per line, optional)">
            <textarea
              value={evidenceLinks}
              onChange={(e) => setEvidenceLinks(e.target.value)}
              placeholder="https://runbooks.acme.com/waf/r-1234"
              rows={2}
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600"
            />
          </Field>
          <Field label="Expires (optional)">
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-[12px] text-neutral-100"
            />
          </Field>
        </div>

        {err && <div className="text-[11px] text-rose-300">{err}</div>}

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
            disabled={
              submitting || !controlId.trim() || !title.trim() || !rationale.trim()
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-3 py-1.5 text-[12px] font-medium text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
            ) : (
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
            )}
            Declare
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
