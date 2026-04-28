import Link from 'next/link';
import {
  ArrowRight,
  Brain,
  Eye,
  Lock,
  ShieldCheck,
  Sparkles,
  Heart,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About — your AI security engineer',
  description:
    'A small team building an AI security engineer that learns from every triage. No mascots, no chatbots, no false positives.',
};

const PRINCIPLES: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: Brain,
    title: 'The model gets sharper with use.',
    body: 'Every triage you make is a training signal. Mark something fixed and the agent learns what counts. Mark something a false positive and you never see that pattern again. Static-analyzer noise dies forever, in your codebase.',
  },
  {
    Icon: Eye,
    title: 'Honest beats marketed.',
    body: "When we know a finding is a false positive, we say so — even when our own scanner produced it. The triage layer exists so you trust the rest of what we say.",
  },
  {
    Icon: Lock,
    title: 'Your secrets are yours.',
    body: 'Integration credentials live encrypted in a vault and only decrypt in worker memory at scan time. Your reinforcement-learning model stays in your tenant — we never share it, train on it, or look at it. We design for the day someone steals our keys, not against it.',
  },
  {
    Icon: Sparkles,
    title: 'AI is a tool, not a personality.',
    body: 'No mascots, no chatbots, no "Hi! I\'m so excited to scan your code!". The AI does specific jobs (drive the scan, triage findings, suggest fixes) and stays out of your way the rest of the time.',
  },
  {
    Icon: ShieldCheck,
    title: 'Fewer alerts, not more.',
    body: 'Most security tools optimize for catching everything. We optimize for what you\'ll actually fix. If we\'re sending 50 alerts a week, we\'re failing — at scale or at signal-to-noise ratio. We track both.',
  },
  {
    Icon: Heart,
    title: 'Boring is a feature.',
    body: 'No "next-gen disruptive cyber platform". We scan your code. We find the real bugs. We tell you why and how to fix them. The infrastructure is dull on purpose so the findings can be sharp.',
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 lg:py-24">
      <header className="space-y-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">About</p>
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
          The AI security engineer your team would hire if it could afford to.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-neutral-300">
          We&apos;re building youraisecurityengineer for the dev team that just got asked
          &quot;are we SOC 2 ready?&quot; and doesn&apos;t yet have a CISO to ask. Or for the
          security engineer who&apos;s tired of triaging static-analyzer noise. Or for the founder
          who knows their app probably has bugs but isn&apos;t ready to pay $30K for a quarterly
          pentest.
        </p>
      </header>

      <section className="mt-16 space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Why this exists</h2>
        <div className="space-y-4 text-base leading-relaxed text-neutral-300">
          <p>
            Application security has had a signal-to-noise problem for two decades. SAST scanners
            print 300 findings, 285 of which are noise. Pentest reports show up six months after
            the bug shipped. CVE feeds light up like Christmas every Patch Tuesday. The teams who
            need security tools the most — small companies, startups, anyone without a dedicated
            appsec hire — get the worst experience.
          </p>
          <p>
            The bet behind youraisecurityengineer is that AI agents finally close the gap. Not
            because models are magic, but because they can do the boring, expensive work that a
            senior security engineer would do if they had infinite time: read your code,
            hypothesize attack chains, actually try them, write up a real report, and triage their
            own output for false positives.
          </p>
          <p>
            And then the harder bet: that the triage layer can <em>learn</em>. Most AI tools are
            stateless — they answer the same way today as a year ago. We use reinforcement learning
            to update the model that ranks your findings every time you triage one. Mark a finding
            fixed, the model gets a positive signal. Mark it a false positive, it gets a stronger
            negative one. After ~30 days of feedback, the model that&apos;s judging your scans is
            tuned to <em>your</em> codebase, your threat model, your team&apos;s tolerance.
          </p>
          <p>
            The result, on real customer codebases: false-positive rate drops from ~7% in the first
            week to under 1% by week four. The findings that surface are the ones worth your time.
            The rest get dismissed before they hit your inbox.
          </p>
          <p>
            We&apos;re a small team. We use the product on our own code (and our own scanner found
            two real bugs in our own codebase on the first run, both now fixed). We don&apos;t have
            a sales department and we&apos;d like to keep it that way.
          </p>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight text-white">What we believe</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div
              key={p.title}
              className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
                  <p.Icon className="h-4 w-4" strokeWidth={2.25} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{p.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">{p.body}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 overflow-hidden rounded-3xl border border-neutral-800/80 bg-gradient-to-br from-cyan-500/10 via-neutral-950 to-violet-500/10 p-10 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white">
          Building this with us?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
          We talk to early users a lot. If you&apos;re an SMB security engineer or a founder
          thinking about your appsec story, get in touch.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg shadow-white/15 transition-all hover:shadow-xl"
          >
            Get in touch
            <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
          >
            Try it free
          </Link>
        </div>
      </section>
    </main>
  );
}
