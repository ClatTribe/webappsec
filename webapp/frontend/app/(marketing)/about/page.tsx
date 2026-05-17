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
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'About',
  description:
    'A small team building TensorShield — the AI security engineer for vibe-coded apps, with continuous memory of your decisions. The same false positive never lands twice.',
  path: '/about',
});

const PRINCIPLES: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: Brain,
    title: 'Tell us once. We remember.',
    body: 'Every dismissal becomes a suppression rule in your workspace with your reason on file. The next scan that would flag the same fingerprint? Suppressed before it hits your inbox — with a chat note citing the rule. The static-analyzer noise pattern dies forever, in your codebase.',
  },
  {
    Icon: Eye,
    title: 'Honest beats marketed.',
    body: "When we know a finding is a false positive, we say so — even when our own scanner produced it. The reasoning trace is one click away on every claim. If we said 90% confidence, you can see why.",
  },
  {
    Icon: Lock,
    title: 'Your data is yours.',
    body: 'Strict workspace isolation on every table. Integration credentials live encrypted in a vault, decrypt only inside the scan sandbox, and get wiped at scan exit. TensorShield\'s memory of your decisions stays in your workspace — we never share it, train a global model on it, or look at it.',
  },
  {
    Icon: Sparkles,
    title: 'A teammate, not a chatbot.',
    body: 'No mascots, no "Hi! I\'m so excited to scan your code!". TensorShield has a name, a chat surface, and a memory of your stack — but the conversation is professional. It does the work; it doesn\'t perform.',
  },
  {
    Icon: ShieldCheck,
    title: 'Fewer alerts, not more.',
    body: 'Most security tools optimize for catching everything. We optimize for what you\'ll actually fix. If we\'re sending 50 alerts a week, we\'re failing — at scale or at signal-to-noise ratio. We track both.',
  },
  {
    Icon: Heart,
    title: 'Continuous beats quarterly.',
    body: 'Quarterly pentests show up six months after the bug shipped. Annual SOC 2 audits feel like a tax. TensorShield runs continuously against your registered assets, updates your compliance posture on every scan, and is on-call 24/7 with no PTO.',
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 lg:py-24">
      <header className="space-y-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">About</p>
        <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
          The AI security engineer for your vibe-coded apps.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-neutral-300">
          We&apos;re building <strong>TensorShield</strong> for the founder who shipped an app in a
          weekend with Cursor and Lovable and isn&apos;t ready to pay $30K for a quarterly pentest.
          For the dev team that just got asked &quot;are we SOC 2 ready?&quot; without a CISO to
          ask. For the engineer who&apos;s tired of triaging static-analyzer noise. The teams who
          need security tools the most — small, fast-moving, no dedicated appsec hire — get the
          worst experience from existing tools. TensorShield is for them.
        </p>
      </header>

      <section className="mt-16 space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Why this exists</h2>
        <div className="space-y-4 text-base leading-relaxed text-neutral-300">
          <p>
            Application security has had a signal-to-noise problem for two decades. SAST scanners
            print 300 findings, 285 of which are noise. Pentest reports show up six months after
            the bug shipped. Compliance tooling collects screenshots once a quarter. Vibe-coded
            apps — shipped fast with AI tools, by founders who can&apos;t afford a security
            engineer — get the worst version of all of this.
          </p>
          <p>
            The bet behind <strong>TensorShield</strong> is that AI agents finally close the gap.
            Not because models are magic, but because they can do the boring, expensive work a
            senior security engineer would do if they had infinite time: read your code,
            hypothesize attack chains, actually try them, write up the report, and triage their
            own output before it reaches you.
          </p>
          <p>
            And then the harder bet: that the relationship can <em>persist</em>. Most security
            tools forget everything between scans. You dismiss the same false positive every
            Monday. You re-explain the same exception every audit. TensorShield is built around a
            different shape — a security engineer with <em>continuous memory</em>. Every dismissal
            becomes a rule with your reason on file. Every scan updates your compliance posture.
            Every interaction lives in a conversation it can refer back to.
          </p>
          <p>
            Dismiss once with a reason. The next scan that would surface the same fingerprint
            doesn&apos;t — you get a chat note saying &quot;suppressed: your rule from 4 days ago
            covers this&quot;. Ask &quot;how ready am I for SOC 2?&quot; — TensorShield answers
            from your workspace, with citations. Tell it &quot;be more aggressive with
            dep-CVEs&quot; — it adjusts the autonomy slider, acknowledges, and acts. The product
            isn&apos;t a dashboard you visit; it&apos;s a teammate who&apos;s been with you for
            two years.
          </p>
          <p>
            We&apos;re a small team. We use TensorShield on our own code, our own production
            URLs, and our own compliance posture. We don&apos;t have a sales department and
            we&apos;d like to keep it that way.
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
