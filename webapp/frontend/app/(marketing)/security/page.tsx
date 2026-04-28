import Link from 'next/link';
import {
  ShieldCheck,
  Lock,
  Eye,
  Database,
  KeyRound,
  Network,
  FileCheck,
  Bell,
  Code2,
  ArrowRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Security & Trust — Strix',
  description:
    'How Strix isolates tenant data, encrypts secrets, and protects your code. Built to shorten the security review from 30 days to 1.',
};

const PILLARS: { Icon: LucideIcon; title: string; bullets: string[] }[] = [
  {
    Icon: Lock,
    title: 'Tenant isolation',
    bullets: [
      'Postgres Row-Level Security on every tenant-scoped table, keyed on the JWT org claim.',
      'Custom JWT hook injects the org_id into every access token at issuance — clients can\'t forge org membership.',
      'Service-role calls go through security-definer RPCs that re-verify org consistency before any insert or update.',
      'Realtime subscriptions are RLS-filtered: the live UI only ever receives rows the JWT can SELECT.',
    ],
  },
  {
    Icon: KeyRound,
    title: 'Secret handling',
    bullets: [
      'Integration credentials (GitHub tokens, AWS roles, kubeconfigs) live in Supabase Vault, encrypted with pgsodium.',
      'Plaintext is never stored on the application table — only an encrypted reference.',
      'Vault decryption only happens inside the worker process, just-in-time per scan, after a multi-step authorization check.',
      'Every decrypt produces an audit_log row.',
      'Worker uses a context manager to wipe credentials from memory and unlink temp files on scan exit, success or failure.',
    ],
  },
  {
    Icon: Database,
    title: 'Data at rest',
    bullets: [
      'All scan data, findings, and audit logs live in Postgres with TLS-only access.',
      'Daily encrypted backups via Supabase, retained per the platform\'s policy.',
      'Per-org data is logically isolated; storage buckets are partitioned by org_id with RLS enforcing the partition.',
    ],
  },
  {
    Icon: Network,
    title: 'Data in transit',
    bullets: [
      'TLS 1.3 between browser and frontend (Vercel-managed).',
      'TLS between frontend and Supabase APIs.',
      'TLS between worker and Supabase via the official client.',
      'No customer data is sent to third parties except your chosen LLM provider, and only as needed for scanning.',
    ],
  },
  {
    Icon: Eye,
    title: 'AI provider isolation',
    bullets: [
      'You choose your LLM provider (OpenAI, Anthropic, Gemini, Bedrock, Ollama, or anything LiteLLM supports).',
      'Bring-your-own-key is supported on every plan — when set, your key replaces ours and traffic flows directly between the worker and your provider.',
      'Keys live in Supabase Vault, decrypted only at scan time. We never see your key.',
      'Scan content is sent only to the LLM provider you select. No scan content is shared with us or with other vendors.',
    ],
  },
  {
    Icon: FileCheck,
    title: 'Audit & evidence',
    bullets: [
      'Every integration use, scan start, role change, and credential decrypt is recorded in audit_log.',
      'Audit history is admin-readable in-app and exportable on Business plans.',
      'Findings are timestamped with a fingerprint that survives across scans — useful for evidencing remediation timelines.',
    ],
  },
];

const PROCESS: { title: string; body: string }[] = [
  {
    title: 'Code review on every change',
    body: 'Every database migration and security-relevant code change goes through review before landing on main. Migrations live in the repo and are runnable end-to-end against a fresh local database — no surprise hotfixes.',
  },
  {
    title: 'Secrets in CI',
    body: 'Service-role keys and LLM keys are stored as encrypted secrets in our CI/deploy platform. Rotation runbook is documented; rotations happen on a regular cadence and on any suspected compromise.',
  },
  {
    title: 'We scan ourselves',
    body: 'We run Strix against this codebase regularly. Two real bugs in this repo were caught and fixed by a Strix scan; you can read about them in our changelog.',
  },
  {
    title: 'Open source, by default',
    body: 'The whole stack is on GitHub under Apache-2.0. Anyone — including you — can audit how isolation, encryption, and credential handling actually work. No security through obscurity.',
  },
];

const SUBPROCESSORS: { name: string; role: string; region: string }[] = [
  { name: 'Vercel', role: 'Frontend hosting + edge functions', region: 'Global' },
  { name: 'Supabase', role: 'Postgres, Auth, Vault, Storage, Realtime', region: 'Configurable per project' },
  { name: 'Fly.io', role: 'Worker compute', region: 'Configurable per app' },
  { name: 'GHCR (GitHub)', role: 'Sandbox container image', region: 'Global CDN' },
  { name: 'Your chosen LLM', role: 'Agent inference (configurable)', region: 'Per provider' },
];

export default function SecurityPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16 lg:py-24">
      <header className="space-y-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          Security & trust
        </p>
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
          Built so you can answer your security review in an afternoon.
        </h1>
        <p className="max-w-3xl text-lg leading-relaxed text-neutral-300">
          We hold customer code, scan results, and integration credentials. We take that seriously.
          This page documents exactly how — what we encrypt, what we audit, and what we don't see at all.
        </p>
      </header>

      <section className="mt-12 grid gap-3 sm:grid-cols-3">
        <TrustBadge label="SOC 2 Type II" status="In progress" Icon={ShieldCheck} />
        <TrustBadge label="GDPR / CCPA" status="Compliant" Icon={FileCheck} />
        <TrustBadge label="Open-source audit-ability" status="Apache-2.0" Icon={Code2} />
      </section>

      <section className="mt-16 space-y-10">
        <h2 className="text-2xl font-semibold tracking-tight text-white">How we protect your data</h2>
        {PILLARS.map((p) => (
          <div
            key={p.title}
            className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 lg:p-8"
          >
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
                <p.Icon className="h-5 w-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-white">{p.title}</h3>
                <ul className="mt-3 space-y-2">
                  {p.bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-neutral-300">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-cyan-400" />
                      <span className="leading-relaxed">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight text-white">How we operate</h2>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {PROCESS.map((p) => (
            <div
              key={p.title}
              className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5"
            >
              <h3 className="text-sm font-semibold text-white">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-300">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Subprocessors</h2>
        <p className="mt-2 text-sm text-neutral-400">
          The third parties that touch your data. Listed in compliance with GDPR Article 28.
        </p>
        <div className="mt-6 overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800/80 bg-neutral-900/40">
              <tr className="text-left text-[11px] uppercase tracking-wider text-neutral-400">
                <th className="px-5 py-3">Vendor</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Region</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {SUBPROCESSORS.map((s) => (
                <tr key={s.name}>
                  <td className="px-5 py-3 font-medium text-neutral-100">{s.name}</td>
                  <td className="px-5 py-3 text-neutral-300">{s.role}</td>
                  <td className="px-5 py-3 text-neutral-400">{s.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-16 grid gap-4 md:grid-cols-2">
        <Link
          href="/security/disclosure"
          className="group rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 transition-colors hover:border-neutral-700"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-200 ring-1 ring-inset ring-amber-500/30">
            <Bell className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">Found a vulnerability?</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            Our responsible-disclosure policy: how to report, what's in scope, what we do next.
          </p>
          <span className="mt-3 inline-flex items-center gap-1 text-xs text-cyan-300 transition-transform group-hover:translate-x-0.5">
            Read the policy
            <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
          </span>
        </Link>
        <Link
          href="/contact"
          className="group rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 transition-colors hover:border-neutral-700"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-200 ring-1 ring-inset ring-cyan-500/30">
            <FileCheck className="h-4 w-4" strokeWidth={2.25} />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">Need a SOC 2 questionnaire?</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            Get in touch. We'll send our latest pre-filled questionnaire + DPA + subprocessor list within one business day.
          </p>
          <span className="mt-3 inline-flex items-center gap-1 text-xs text-cyan-300 transition-transform group-hover:translate-x-0.5">
            Get in touch
            <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
          </span>
        </Link>
      </section>
    </main>
  );
}

function TrustBadge({
  label,
  status,
  Icon,
}: {
  label: string;
  status: string;
  Icon: LucideIcon;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-4">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
        <Icon className="h-4 w-4" strokeWidth={2.25} />
      </div>
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        <div className="text-[11px] text-neutral-400">{status}</div>
      </div>
    </div>
  );
}
