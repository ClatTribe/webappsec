import Link from 'next/link';
import { ArrowRight, Sparkles, Wrench, Bug, Plus, Rss } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Changelog — your AI security engineer',
  description: 'Every shipping update from the team. Updated weekly.',
};

type Tag = 'new' | 'improved' | 'fixed';
const TAG: Record<Tag, { label: string; Icon: LucideIcon; cls: string }> = {
  new: { label: 'New', Icon: Plus, cls: 'bg-cyan-500/15 text-cyan-200 ring-cyan-500/30' },
  improved: {
    label: 'Improved',
    Icon: Wrench,
    cls: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
  },
  fixed: {
    label: 'Fixed',
    Icon: Bug,
    cls: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30',
  },
};

interface Entry {
  date: string;
  version?: string;
  title: string;
  blurb: string;
  changes: { tag: Tag; line: string }[];
}

const ENTRIES: Entry[] = [
  {
    date: '2026-04-28',
    version: 'v0.5',
    title: 'Targets, RL triage, and the public marketing site',
    blurb:
      'A big batch. The product now thinks of your assets as first-class targets, the reinforcement-trained reviewer auto-triages findings to cut false positives, and we have a full marketing site for the first time.',
    changes: [
      {
        tag: 'new',
        line: 'Targets are first-class — every asset (repo, app, domain, IP) gets a permanent home with stat tiles, scan history, and per-target finding rollup.',
      },
      {
        tag: 'new',
        line: 'Reinforcement-trained triage rates every finding for reachability and urgency. False positives get auto-dismissed. Each triage you make sharpens the model that ranks the next finding.',
      },
      {
        tag: 'new',
        line: 'Editable Settings page with a per-organization LLM provider + Vault-stored API key. Bring your own model or use ours.',
      },
      {
        tag: 'new',
        line: 'Triage workflow inside each finding card: Fixed / Confirmed real / False positive / Won\'t fix / Reopen — every triage trains your private model.',
      },
      {
        tag: 'new',
        line: 'Fingerprint-based cross-scan deduplication — the same finding across N scans is one row with a "seen N×" pill.',
      },
      {
        tag: 'new',
        line: 'Public landing page, plus pricing, about, security, and disclosure pages.',
      },
      {
        tag: 'improved',
        line: 'Modern UI pass — refreshed type system, severity-tinted finding cards, animated status indicators, glassmorphic chrome.',
      },
      {
        tag: 'improved',
        line: 'Live activity timeline on each scan — collapsible, color-keyed event types, click any row to inspect the underlying payload.',
      },
      {
        tag: 'improved',
        line: '/findings and /scans now show the target column with a clickable link, plus a target dropdown filter.',
      },
      {
        tag: 'fixed',
        line: 'Authentication hook 500\'d on every signup. Both root causes (column ambiguity + missing security context) fixed.',
      },
      {
        tag: 'fixed',
        line: 'RLS recursion on org_members caused most member-aware queries to fail silently. Replaced with a security-definer helper.',
      },
      {
        tag: 'fixed',
        line: 'Severity parser was silently dropping every finding. Replaced the buggy split() with a literal-prefix match.',
      },
      {
        tag: 'fixed',
        line: 'SSRF in the scan-target validator — caught by our own scanner pointing at our own service. The /api/scans endpoint now rejects loopback, RFC1918, link-local, and cloud-metadata IPs.',
      },
      {
        tag: 'fixed',
        line: 'Audit gap in the per-org LLM-key decrypt RPC — now writes an audit_log row and raises a clear error when the scan ID is bogus.',
      },
    ],
  },
  {
    date: '2026-04-27',
    version: 'v0.4',
    title: 'Architecture documented, tests for every workflow',
    blurb:
      'A documentation + reliability push. Wrote up the isolation model, added end-to-end tests covering the scan flow, and pinned the test mocks to production format.',
    changes: [
      {
        tag: 'new',
        line: 'Internal architecture documentation describing how scans are isolated across users and parallel runs.',
      },
      {
        tag: 'new',
        line: 'Worker-side tests covering scan lifecycle, parallel cross-org isolation, LLM resolution precedence, credential cleanup, and secret-non-leakage.',
      },
      {
        tag: 'new',
        line: 'SQL workflow tests for the queue trigger, authentication hook, RLS isolation, vault-create gate, and decrypt-integration enforcement chain.',
      },
    ],
  },
  {
    date: '2026-04-27',
    title: 'Initial release',
    blurb:
      'The product boots. Three tiers (frontend, database, worker) with multi-tenant isolation enforced at the database layer. Scans run in isolated sandboxes with per-scan credentials.',
    changes: [
      { tag: 'new', line: 'Frontend: signup, dashboard, scan UI, integrations, real-time scan view.' },
      {
        tag: 'new',
        line: 'Database: 7 migrations covering tables, RLS, JWT hook, encrypted secret storage, queue trigger, worker RPCs, and Realtime publication.',
      },
      {
        tag: 'new',
        line: 'Worker: bounded-concurrency scan dispatcher, just-in-time credential decryption, AWS sts:AssumeRole, temp-file management.',
      },
    ],
  },
];

export default function ChangelogPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
            Changelog
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            What we shipped.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-neutral-300">
            Every meaningful update from the team, newest first. We update this page weekly.
          </p>
        </div>
        <Link
          href="/blog/rss.xml"
          className="hidden items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 sm:inline-flex"
        >
          <Rss className="h-3.5 w-3.5" />
          RSS
        </Link>
      </header>

      <div className="mt-12 space-y-12">
        {ENTRIES.map((e) => (
          <Entry key={e.date + (e.version ?? '')} entry={e} />
        ))}
      </div>

      <section className="mt-20 overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/40 p-8 text-center">
        <Sparkles className="mx-auto h-5 w-5 text-cyan-300" strokeWidth={2.25} />
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-white">
          Want the latest, in product?
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
          The free tier ships every release on day one. Try it.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-md shadow-white/15 hover:shadow-lg"
          >
            Try the product
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </Link>
        </div>
      </section>
    </main>
  );
}

function Entry({ entry: e }: { entry: Entry }) {
  return (
    <article className="relative">
      <div className="flex items-baseline gap-3">
        <time className="font-mono text-[11px] text-neutral-500">{e.date}</time>
        {e.version && (
          <span className="rounded-md bg-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-300">
            {e.version}
          </span>
        )}
      </div>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">{e.title}</h2>
      <p className="mt-2 text-base leading-relaxed text-neutral-300">{e.blurb}</p>
      <ul className="mt-5 space-y-2.5">
        {e.changes.map((c, i) => {
          const t = TAG[c.tag];
          const Icon = t.Icon;
          return (
            <li key={i} className="flex items-start gap-3">
              <span
                className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${t.cls}`}
              >
                <Icon className="h-3 w-3" strokeWidth={2.5} />
                {t.label}
              </span>
              <span className="text-sm leading-relaxed text-neutral-300">{c.line}</span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
