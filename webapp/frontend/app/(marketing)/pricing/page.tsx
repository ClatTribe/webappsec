import Link from 'next/link';
import {
  ArrowRight,
  Check,
  X,
  Sparkles,
  Zap,
  Building2,
  Code2,
  HelpCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Pricing',
  description:
    'Free for personal projects. From $99/mo for teams. No per-finding fees. No surprise bills. Reinforcement-trained triage on every plan.',
  path: '/pricing',
});

interface Tier {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  cta: { label: string; href: string };
  highlight?: boolean;
  Icon: LucideIcon;
  bullets: string[];
}

const TIERS: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    tagline: 'For solo devs and side projects.',
    cta: { label: 'Start free', href: '/signup' },
    Icon: Sparkles,
    bullets: [
      '5 scans / month',
      'Public GitHub repos',
      'Reinforcement-trained AI triage',
      '1 user',
      'Community support',
    ],
  },
  {
    name: 'Team',
    price: '$99',
    cadence: '/ workspace / month',
    tagline: 'For dev teams scanning their own code.',
    cta: { label: 'Start 14-day trial', href: '/signup' },
    highlight: true,
    Icon: Zap,
    bullets: [
      '100 scans / month',
      'Private repos · scheduled scans · all integrations',
      'GitHub PR comments · Slack · webhooks',
      'Up to 10 users',
      'Email support',
      'RL triage with reasoning + reachability',
    ],
  },
  {
    name: 'Business',
    price: '$499',
    cadence: '/ workspace / month',
    tagline: 'For companies with a real security posture.',
    cta: { label: 'Start 14-day trial', href: '/signup' },
    Icon: Building2,
    bullets: [
      'Unlimited scans',
      'SOC 2 evidence exports (SARIF, JSON, CSV)',
      'Compliance mapping (OWASP, CWE, PCI-DSS)',
      'Priority support · 24h response',
      'Up to 25 users',
      'Audit log retention controls',
    ],
  },
];

const MATRIX: { label: string; values: [string | boolean, string | boolean, string | boolean] }[] = [
  { label: 'Scans per month', values: ['5', '100', 'Unlimited'] },
  { label: 'Users per workspace', values: ['1', '10', '25'] },
  { label: 'Public GitHub repos', values: [true, true, true] },
  { label: 'Private repos', values: [false, true, true] },
  { label: 'Scheduled scans (daily / weekly / monthly)', values: [false, true, true] },
  { label: 'AI triage with reachability + reasoning', values: ['Basic', true, true] },
  { label: 'GitHub PR comments', values: [false, true, true] },
  { label: 'Slack / webhook notifications', values: [false, true, true] },
  { label: 'AWS / Azure / GCP / Kubernetes integrations', values: [false, true, true] },
  { label: 'SARIF / CSV / JSON export', values: [false, false, true] },
  { label: 'Compliance mapping (OWASP / CWE / PCI)', values: [false, false, true] },
  { label: 'Audit log retention controls', values: ['30 days', '90 days', 'Configurable'] },
  { label: 'Reinforcement-trained triage', values: [true, true, true] },
  { label: 'Priority support', values: [false, false, true] },
];

const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: 'How does the free tier really work?',
    a: 'Five quick scans per month against any public GitHub repo, with full AI triage and the same UI as paid tiers. No credit card. No "free trial that auto-converts" — you stay on Free until you click upgrade.',
  },
  {
    q: 'What counts as a scan?',
    a: 'One run of the scanner against one target. A scan against a 2-million-line monorepo and a scan against a 5-page side project both count as one. We charge by scan count, not codebase size.',
  },
  {
    q: 'What if I exceed my monthly quota?',
    a: 'New scans are blocked at the limit with a clear in-app message. We never auto-charge overage. Bump your plan or wait for the monthly reset.',
  },
  {
    q: 'Can I bring my own LLM key?',
    a: 'Yes — every plan supports BYO LLM keys (OpenAI, Anthropic, Gemini, Bedrock, Ollama, anything LiteLLM speaks). Stored encrypted in Supabase Vault, decrypted only at scan time. When set, your key replaces ours and your scans are billed to your provider, not us.',
  },
  {
    q: 'How does the AI actually reduce false positives?',
    a: "Every finding goes through a reinforcement-trained reviewer that rates reachability, exploitability, and false-positive likelihood. Each time you triage (mark fixed / false positive / won't fix), the model that ranks the next finding gets better at understanding your codebase. After ~30 days of feedback, FP rate drops below 1% on most teams.",
  },
  {
    q: 'Do you offer annual billing?',
    a: 'Yes — 20% off when paid annually. Available at signup or any time from your billing dashboard.',
  },
  {
    q: 'How do you bill if my team grows?',
    a: 'Per workspace, not per user. Add users mid-month at no charge until you hit the seat cap. Need more seats? Bump to Business or contact us — we have flexible expansion pricing.',
  },
  {
    q: 'What about enterprise needs (SSO, SCIM, on-prem)?',
    a: (
      <>
        Coming. SSO and SCIM are on our{' '}
        <Link href="/changelog" className="text-cyan-300 hover:underline">
          roadmap
        </Link>
        . Need them today?{' '}
        <Link href="/contact" className="text-cyan-300 hover:underline">
          Get in touch
        </Link>{' '}
        — we can prioritize for design partners and offer custom deployment options.
      </>
    ),
  },
  {
    q: 'How do refunds work?',
    a: "Cancel any time, no questions. We don't pro-rate mid-cycle, but we don't charge for the next cycle either. If you've been billed for a service that didn't work for you, email us and we'll make it right.",
  },
];

// Plain-text answers for the FAQPage schema. The on-page <a> answers are
// fine for humans, but Google's structured-data validator wants plain
// strings — so we mirror the text once for the schema.
const FAQ_PLAIN_ANSWERS: Record<string, string> = {
  'How does the free tier really work?':
    'Five quick scans per month against any public GitHub repo, with full AI triage and the same UI as paid tiers. No credit card. No free trial that auto-converts — you stay on Free until you click upgrade.',
  'What counts as a scan?':
    'One run of the scanner against one target. A scan against a 2-million-line monorepo and a scan against a 5-page side project both count as one. We charge by scan count, not codebase size.',
  'What if I exceed my monthly quota?':
    'New scans are blocked at the limit with a clear in-app message. We never auto-charge overage. Bump your plan or wait for the monthly reset.',
  'Can I bring my own LLM key?':
    'Yes — every plan supports BYO LLM keys (OpenAI, Anthropic, Gemini, Bedrock, Ollama, anything LiteLLM speaks). Stored encrypted in Supabase Vault, decrypted only at scan time.',
  'How does the AI actually reduce false positives?':
    'Every finding goes through a reinforcement-trained reviewer that rates reachability, exploitability, and false-positive likelihood. Each time you triage, the model gets better at your codebase. After ~30 days of feedback, FP rate drops below 1% on most teams.',
  'Do you offer annual billing?':
    'Yes — 20% off when paid annually. Available at signup or any time from your billing dashboard.',
  'How do you bill if my team grows?':
    'Per workspace, not per user. Add users mid-month at no charge until you hit the seat cap. Need more seats? Bump to Business or contact us.',
  'What about enterprise needs (SSO, SCIM, on-prem)?':
    'SSO and SCIM are on our roadmap. Need them today? Get in touch — we can prioritize for design partners and offer custom deployment options.',
  'How do refunds work?':
    "Cancel any time, no questions. We don't pro-rate mid-cycle, but we don't charge for the next cycle either. If you've been billed for a service that didn't work for you, email us and we'll make it right.",
};

const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: {
      '@type': 'Answer',
      text: FAQ_PLAIN_ANSWERS[f.q] ?? '',
    },
  })),
};

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
      />
      <header className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Pricing</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Simple, fair pricing.{' '}
          <span className="bg-gradient-to-br from-cyan-300 to-violet-300 bg-clip-text text-transparent">
            No per-finding fees.
          </span>
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-neutral-300">
          Free for solo projects. $99/month for teams. The price doesn&apos;t go up because we
          found a critical CVE in your code — that would be backwards.
        </p>
      </header>

      <section className="mt-14 grid gap-4 lg:grid-cols-3">
        {TIERS.map((t) => (
          <TierCard key={t.name} tier={t} />
        ))}
      </section>

      <section className="mt-12 rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-cyan-500/5 p-6 lg:p-10">
        <div className="grid items-center gap-6 lg:grid-cols-[auto_1fr_auto]">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/20 text-violet-200 ring-1 ring-inset ring-white/5">
            <Code2 className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">
              Reinforcement-trained on every plan.
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">
              Every triage you make trains the model that ranks the next finding. Your private
              feedback loop, your data, your sharper signal. Free, Team, and Business tiers all
              include the full RL triage layer.
            </p>
          </div>
          <Link
            href="/blog/ai-triage-explained"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
          >
            How it works
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </Link>
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Compare features</h2>
        <p className="mt-2 text-sm text-neutral-400">Every line item, every plan.</p>

        <div className="mt-6 overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/20">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800/80 bg-neutral-900/40">
              <tr>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Feature
                </th>
                {TIERS.map((t) => (
                  <th
                    key={t.name}
                    className="px-5 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-neutral-400"
                  >
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {MATRIX.map((row) => (
                <tr key={row.label} className="transition-colors hover:bg-neutral-900/30">
                  <td className="px-5 py-3 text-neutral-200">{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className="px-5 py-3 text-center">
                      {typeof v === 'boolean' ? (
                        v ? (
                          <Check className="mx-auto h-4 w-4 text-emerald-400" strokeWidth={2.5} />
                        ) : (
                          <X className="mx-auto h-4 w-4 text-neutral-700" strokeWidth={2} />
                        )
                      ) : (
                        <span className="text-neutral-300">{v}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-20">
        <div className="flex items-center gap-2.5">
          <HelpCircle className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h2 className="text-2xl font-semibold tracking-tight text-white">Frequently asked</h2>
        </div>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {FAQS.map((f) => (
            <div
              key={f.q}
              className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5"
            >
              <h3 className="text-base font-semibold text-white">{f.q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-300">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 overflow-hidden rounded-3xl border border-neutral-800/80 bg-neutral-900/40 p-10 text-center lg:p-16">
        <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Try it. The free tier is real.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
          5 scans, 1 user, full AI triage, no card, no email upsell. If you don't get value in 10
          minutes, you won't get value in a month.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-6 py-3 text-base font-semibold text-neutral-950 shadow-lg shadow-white/20 transition-all hover:shadow-xl"
          >
            Start free
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              strokeWidth={2.5}
            />
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-6 py-3 text-base font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
          >
            Talk to us
          </Link>
        </div>
      </section>
    </main>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  const Icon = tier.Icon;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border p-6 transition-all ${
        tier.highlight
          ? 'border-cyan-500/40 bg-gradient-to-b from-cyan-500/10 via-neutral-900/40 to-neutral-900/30 ring-1 ring-cyan-500/30'
          : 'border-neutral-800/80 bg-neutral-900/30 hover:border-neutral-700'
      }`}
    >
      {tier.highlight && (
        <div className="mb-4 inline-flex items-center gap-1 rounded-full bg-cyan-500/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-200 ring-1 ring-cyan-500/30">
          Most popular
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-inset ring-white/5 ${
            tier.highlight
              ? 'bg-cyan-500/20 text-cyan-200'
              : 'bg-neutral-900 text-neutral-300'
          }`}
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <h3 className="text-lg font-semibold text-white">{tier.name}</h3>
      </div>
      <p className="mt-4 text-sm text-neutral-400">{tier.tagline}</p>
      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-tight text-white">{tier.price}</span>
        <span className="text-sm text-neutral-500">{tier.cadence}</span>
      </div>
      <Link
        href={tier.cta.href}
        className={`mt-5 flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
          tier.highlight
            ? 'bg-gradient-to-b from-white to-neutral-200 text-neutral-950 shadow-md shadow-white/20 hover:shadow-lg'
            : 'border border-neutral-800 bg-neutral-900/60 text-neutral-100 hover:border-neutral-700 hover:bg-neutral-900'
        }`}
      >
        {tier.cta.label}
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
      </Link>
      <ul className="mt-6 space-y-2.5 text-sm">
        {tier.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2">
            <Check
              className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                tier.highlight ? 'text-cyan-300' : 'text-emerald-400'
              }`}
              strokeWidth={2.25}
            />
            <span className="text-neutral-200">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
