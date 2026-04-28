import Link from 'next/link';
import {
  ArrowRight,
  Code2,
  Eye,
  Lock,
  ShieldCheck,
  Sparkles,
  Heart,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About — Strix',
  description:
    'A small team building security tooling that doesn\'t require a security team to use. Open-source, AI-first, dev-led.',
};

const PRINCIPLES: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: Eye,
    title: 'Honest beats marketed.',
    body: 'We tell you when a finding is a false positive, even when our scanner produced it. The AI triage layer exists so you trust the rest of what we say.',
  },
  {
    Icon: Code2,
    title: 'Open source by default.',
    body: 'The whole stack is on GitHub under Apache-2.0. If you want to read the code that\'s reading your code, you can. If you want to self-host it, you can. We trust you to make the call.',
  },
  {
    Icon: Lock,
    title: 'Your secrets are yours.',
    body: 'Integration credentials live encrypted in a vault and only decrypt in worker memory at scan time. Your LLM API key, when set, is yours — we never see it. We design for the day someone steals our service-role key, not against it.',
  },
  {
    Icon: Sparkles,
    title: 'AI is a tool, not a personality.',
    body: 'No mascots, no chatbots, no "Hi! I\'m Strix and I\'m so excited to scan your code!" The AI does specific jobs (drive the scan, triage findings, suggest fixes) and stays out of your way the rest of the time.',
  },
  {
    Icon: ShieldCheck,
    title: 'Fewer alerts, not more.',
    body: 'Most security tools optimize for catching everything. We optimize for what you\'ll actually fix. If we\'re sending 50 alerts a week, we\'re failing — at scale or at signal-to-noise ratio. We track both.',
  },
  {
    Icon: Heart,
    title: 'Boring is a feature.',
    body: 'No "AI-powered next-gen disruptive cyber platform". Strix scans your code. It tells you what\'s wrong. It explains why and how to fix it. The infrastructure is dull on purpose so the findings can be sharp.',
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 lg:py-24">
      <header className="space-y-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">About</p>
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
          Security tooling that doesn't require a security team to use.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-neutral-300">
          We're building Strix for the dev team that just got asked "are we SOC 2 ready?" and
          doesn't yet have a CISO to ask. Or for the security engineer who's tired of triaging
          static-analyzer noise. Or for the founder who knows their app probably has bugs but isn't
          ready to pay $30K for a quarterly pentest.
        </p>
      </header>

      <section className="mt-16 space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight text-white">
          Why this exists
        </h2>
        <div className="space-y-4 text-base leading-relaxed text-neutral-300">
          <p>
            Application security has had a signal-to-noise problem for two decades. SAST scanners
            print 300 findings, 285 of which are noise. Pentest reports show up six months after
            the bug shipped. CVE feeds light up like Christmas every Patch Tuesday. The teams who
            need security tools the most — small companies, startups, anyone without a dedicated
            appsec hire — get the worst experience.
          </p>
          <p>
            The bet behind Strix is that AI agents finally close the gap. Not because models are
            magic, but because they can do the boring, expensive work that a senior security
            engineer would do if they had infinite time: read your code, hypothesize attack chains,
            actually try them, write up a real report, and triage their own output for false
            positives.
          </p>
          <p>
            What we build on top of the open-source{' '}
            <a
              href="https://github.com/usestrix/strix"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:underline"
            >
              Strix agent
            </a>{' '}
            is the boring infrastructure: multi-tenant isolation so your scans don't leak across
            organizations, a triage workflow so findings don't pile up forever, scheduled scans so
            you don't have to remember, and a UI that explains what each finding means in plain
            English. The hard part isn't running the agent. The hard part is making the output
            useful enough that a busy team will actually act on it.
          </p>
          <p>
            We're a small team. We use the product on our own code (and Strix found two real bugs
            in this very repo on the first run, both now fixed). We don't have a sales department
            and we'd like to keep it that way.
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

      <section className="mt-16 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-8">
        <h2 className="text-xl font-semibold text-white">Built on the shoulders of</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Strix wouldn't exist without the open-source security and AI ecosystem. In particular:
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-cyan-400" />
            <span className="text-neutral-300">
              <a
                href="https://github.com/usestrix/strix"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-cyan-300 hover:underline"
              >
                usestrix/strix
              </a>{' '}
              — the AI security agent itself, MIT-licensed, the engine our wrapper drives.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-cyan-400" />
            <span className="text-neutral-300">
              <a
                href="https://github.com/BerriAI/litellm"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-cyan-300 hover:underline"
              >
                LiteLLM
              </a>{' '}
              — the universal API the agent uses to talk to any model provider.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-cyan-400" />
            <span className="text-neutral-300">
              <a
                href="https://supabase.com"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-cyan-300 hover:underline"
              >
                Supabase
              </a>{' '}
              — Postgres + Auth + Vault + Realtime, which lets a small team ship multi-tenant
              quickly.
            </span>
          </li>
        </ul>
      </section>

      <section className="mt-16 overflow-hidden rounded-3xl border border-neutral-800/80 bg-gradient-to-br from-cyan-500/10 via-neutral-950 to-violet-500/10 p-10 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white">
          Building this with us?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
          We talk to early users a lot. If you're an SMB security engineer or a founder thinking
          about your appsec story, get in touch.
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
