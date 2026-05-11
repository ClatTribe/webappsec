import Link from 'next/link';
import {
  ArrowRight,
  Sparkles,
  Lock,
  CheckCircle2,
  MessageSquare,
  ShieldCheck,
  Workflow,
  Brain,
  Eye,
  AlertTriangle,
  Bot,
  GitBranch,
  User,
  Send,
  Hash,
  Activity,
  FileLock,
  Repeat,
  Target as TargetIcon,
  Zap,
  Clock,
  GitPullRequest,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'TensorShield — AI security engineer for your vibe-coded apps',
  description:
    "TensorShield is the AI security engineer for your vibe-coded apps. It scans your code, watches your URLs, triages findings as you make decisions, and remembers everything. The same false positive never lands twice.",
  path: '/',
  rawTitle: true,
});

export default function LandingPage() {
  return (
    <>
      <Hero />
      <ProofStrip />
      <ClosedLoop />
      <Capabilities />
      <Personas />
      <HowItWorks />
      <ComparisonTable />
      <FinalCta />
    </>
  );
}

// ============================================================================
// HERO — chat mockup as the centerpiece. The product is the conversation.
// ============================================================================

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 lg:pt-28 lg:pb-24">
      <div className="grid items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
            <Sparkles className="h-3 w-3" strokeWidth={2.5} />
            AI security engineer for vibe-coded apps
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Your AI security engineer.{' '}
            <span className="bg-gradient-to-br from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
              Never forgets.
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-neutral-300">
            You vibe-coded an app. You shipped it. Now you need someone to keep it secure.
            TensorShield scans your code, watches your URLs, and triages findings as you make
            decisions — then remembers every dismissal, every fix, every exception. The same
            false positive never lands twice.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-3 text-sm font-semibold text-neutral-950 shadow-lg shadow-white/15 transition-all hover:shadow-xl hover:shadow-white/25"
            >
              Start free
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                strokeWidth={2.5}
              />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-3 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
            >
              See pricing
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-400">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              5 free scans / month
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              No credit card
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              First finding in &lt; 10 min
            </span>
          </div>
        </div>

        <div className="lg:col-span-6">
          <HeroChatMockup />
        </div>
      </div>
    </section>
  );
}

function HeroChatMockup() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-cyan-500/20 via-blue-500/10 to-violet-500/20 blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-950/80 shadow-2xl shadow-black/50 backdrop-blur">
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/60 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <span className="font-mono text-[10.5px] text-neutral-500">tensorshield.ai · your workspace</span>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-[10px] text-neutral-400">live</span>
          </div>
        </div>

        {/* Chat thread */}
        <div className="space-y-4 p-5">
          <ChatMessage role="agent" timeAgo="9:02 AM">
            <p className="text-sm leading-relaxed text-neutral-100">
              🛑 <span className="font-semibold">Critical</span> — SQL injection at{' '}
              <code className="rounded bg-neutral-800/60 px-1 py-0.5 font-mono text-[11px]">
                /api/login
              </code>
            </p>
            <p className="mt-1.5 text-xs text-neutral-400">
              Found in <code className="font-mono">getedunext-api</code>. I verified it&apos;s
              reachable from production right now and drafted a fix PR.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill cyan>See diff</Pill>
              <Pill>Apply fix</Pill>
              <Pill>Dismiss</Pill>
            </div>
          </ChatMessage>

          <ChatMessage role="user" timeAgo="9:03 AM">
            <p className="text-sm text-neutral-100">apply the fix</p>
          </ChatMessage>

          <ChatMessage role="agent" timeAgo="9:03 AM">
            <p className="text-sm leading-relaxed text-neutral-100">
              ✓ Merged{' '}
              <span className="text-cyan-300">PR #289</span> with a regression test.
            </p>
            <p className="mt-1.5 text-xs text-neutral-400">
              The 3 lodash dep-CVEs from this morning are the same fix pattern as last week. Want
              me to bump them too?
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill cyan>Yes, bump them</Pill>
              <Pill>Show me first</Pill>
            </div>
          </ChatMessage>
        </div>

        {/* Composer */}
        <div className="border-t border-neutral-800/60 bg-neutral-900/40 px-4 py-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
              Ask TensorShield anything about your scans, findings, or assets…
            </div>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/20">
              <Send className="h-3.5 w-3.5" />
            </span>
          </div>
          <p className="mt-2 text-[10px] text-neutral-500">
            Your workspace · findings, scans, and compliance evidence stay private to your
            account.
          </p>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({
  role,
  timeAgo,
  children,
}: {
  role: 'agent' | 'user';
  timeAgo: string;
  children: React.ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className="flex-shrink-0 pt-0.5">
        {isUser ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-700 text-neutral-300">
            <User className="h-3.5 w-3.5" />
          </div>
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 shadow-md shadow-cyan-500/20">
            <Sparkles className="h-3.5 w-3.5 text-white" />
          </div>
        )}
      </div>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser ? 'bg-cyan-500/15 text-neutral-100' : 'bg-neutral-900/60 text-neutral-100'
          }`}
        >
          {children}
        </div>
        <div className={`mt-1 text-[9px] text-neutral-600 ${isUser ? 'text-right' : 'text-left'}`}>
          {timeAgo}
        </div>
      </div>
    </div>
  );
}

function Pill({
  children,
  cyan,
  emerald,
}: {
  children: React.ReactNode;
  cyan?: boolean;
  emerald?: boolean;
}) {
  if (cyan) {
    return (
      <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[10.5px] font-medium text-cyan-200">
        {children}
      </span>
    );
  }
  if (emerald) {
    return (
      <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10.5px] font-medium text-emerald-200">
        {children}
      </span>
    );
  }
  return (
    <span className="rounded-md border border-neutral-700 bg-neutral-800/60 px-2.5 py-1 text-[10.5px] text-neutral-200">
      {children}
    </span>
  );
}

// ============================================================================
// PROOF STRIP — numbers that reflect the product reality, not generic puffery
// ============================================================================

function ProofStrip() {
  const stats: { value: string; label: string }[] = [
    { value: '0', label: 'Re-flagging of a dismissed pattern, ever' },
    { value: '24/7', label: 'Continuous monitoring across registered assets' },
    { value: '< 10 min', label: 'From signup to first triaged finding' },
    { value: '5+', label: 'Surfaces: chat, PR, Slack, trust page, API' },
  ];
  return (
    <section className="border-y border-neutral-900/60 bg-neutral-950/30 py-10">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className="bg-gradient-to-br from-cyan-300 to-blue-300 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
                {s.value}
              </div>
              <div className="mt-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// CLOSED LOOP — the moat. Show the 3-step learning loop visually.
// ============================================================================

function ClosedLoop() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-300/80">
          The moat
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Tell TensorShield once.{' '}
          <span className="bg-gradient-to-br from-violet-300 to-cyan-300 bg-clip-text text-transparent">
            It&apos;ll never re-ask.
          </span>
        </h2>
        <p className="mt-4 text-base leading-relaxed text-neutral-400">
          Every dismissal becomes a rule with your reason on file. The next scan that would&apos;ve
          flagged the same fingerprint? Suppressed before it hits your inbox — with a chat note
          citing the rule.
        </p>
      </div>

      <div className="mt-14 grid items-start gap-4 lg:grid-cols-3">
        <LoopStep
          n={1}
          tone="amber"
          title="TensorShield finds it"
          chip="🟡 Low — Missing X-Frame-Options"
          quote="Found on /search, /about, /contact. [Dismiss] [Suggest fix]"
        />
        <LoopArrow />
        <LoopStep
          n={2}
          tone="emerald"
          title="You dismiss with a reason"
          chip='"Behind Cloudflare WAF — header injected at the edge"'
          quote="TensorShield records the rule (fingerprint + reason, confidence 0.75)."
        />
      </div>
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="hidden lg:block" />
        <LoopArrow down />
        <div className="hidden lg:block" />
      </div>
      <div className="mt-4 flex justify-center">
        <LoopStep
          n={3}
          tone="violet"
          wide
          title="Next scan: suppressed before you see it"
          chip="🤐 Suppressed: Missing X-Frame-Options on /pricing"
          quote='Your rule from 4 days ago covers this (dismissed 3 times, "Behind Cloudflare WAF").'
        />
      </div>

      <p className="mx-auto mt-12 max-w-xl text-center text-sm text-neutral-500">
        Your dismissal lives in your workspace. Rules apply only to your assets and are verifiable
        in every scan&apos;s audit trail.
      </p>
    </section>
  );
}

function LoopStep({
  n,
  tone,
  title,
  chip,
  quote,
  wide,
}: {
  n: number;
  tone: 'amber' | 'emerald' | 'violet';
  title: string;
  chip: string;
  quote: string;
  wide?: boolean;
}) {
  const toneClass = {
    amber: { ring: 'ring-amber-500/30', text: 'text-amber-300', bg: 'from-amber-500/8' },
    emerald: { ring: 'ring-emerald-500/30', text: 'text-emerald-300', bg: 'from-emerald-500/8' },
    violet: { ring: 'ring-violet-500/30', text: 'text-violet-300', bg: 'from-violet-500/8' },
  }[tone];
  return (
    <div
      className={`rounded-2xl border border-neutral-800/80 bg-gradient-to-b ${toneClass.bg} to-transparent p-5 ring-1 ${toneClass.ring} ${wide ? 'max-w-md' : ''}`}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-neutral-500">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 font-mono font-semibold ${toneClass.text}`}
        >
          {n}
        </span>
        Step {n}
      </div>
      <h3 className="mt-3 text-base font-semibold text-white">{title}</h3>
      <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-[12px] text-neutral-200">
        {chip}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-neutral-400">{quote}</p>
    </div>
  );
}

function LoopArrow({ down }: { down?: boolean }) {
  return (
    <div className="flex items-center justify-center py-4 text-neutral-700">
      <ArrowRight
        className={`h-5 w-5 ${down ? 'rotate-90' : ''}`}
        strokeWidth={2}
      />
    </div>
  );
}

// ============================================================================
// CAPABILITIES — the actual feature surface area
// ============================================================================

function Capabilities() {
  const items: {
    Icon: LucideIcon;
    title: string;
    body: string;
    tone: 'cyan' | 'violet' | 'emerald' | 'amber' | 'blue' | 'rose';
  }[] = [
    {
      Icon: MessageSquare,
      title: 'In-app chat that knows your stack',
      body:
        'TensorShield carries continuous memory of your repos, your decisions, your past triages. Ask "what was the SSRF we found last quarter?" — it remembers.',
      tone: 'cyan',
    },
    {
      Icon: Hash,
      title: 'Slack #security as a second home',
      body:
        'Findings, dismissal confirmations, and compliance posture updates land in your team\'s channel automatically. Opt-in.',
      tone: 'violet',
    },
    {
      Icon: Activity,
      title: 'Continuous scanning, not on-demand',
      body:
        'Register an asset with a cadence. TensorShield scans daily, weekly, or on-push without you touching the dashboard. Drift gets flagged the moment it lands.',
      tone: 'blue',
    },
    {
      Icon: Repeat,
      title: 'Closed-loop suppression learning',
      body:
        'Dismiss once with a reason. The pattern is suppressed on the next scan with a chat note citing your rule. Fingerprint-precise, fully auditable.',
      tone: 'emerald',
    },
    {
      Icon: FileLock,
      title: 'Compliance as a living document',
      body:
        'SOC 2 / ISO 27001 evidence collected from every scan. A public Trust Page for prospects and auditors. Updates in real time.',
      tone: 'amber',
    },
    {
      Icon: Workflow,
      title: 'Autonomy slider per category',
      body:
        '"Auto-fix critical dep-CVEs but ask me on medium" — tell TensorShield in chat. The slider scales with your trust; no need to click "Apply Fix" 47 times.',
      tone: 'rose',
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          What you get
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          One AI security engineer.{' '}
          <span className="text-neutral-400">Five surfaces. One memory.</span>
        </h2>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <CapabilityCard key={it.title} {...it} />
        ))}
      </div>
    </section>
  );
}

const TONE_CARD: Record<string, { ring: string; bg: string; iconBg: string; iconText: string }> = {
  cyan: { ring: 'ring-cyan-500/20', bg: 'from-cyan-500/8', iconBg: 'bg-cyan-500/15', iconText: 'text-cyan-200' },
  violet: { ring: 'ring-violet-500/20', bg: 'from-violet-500/8', iconBg: 'bg-violet-500/15', iconText: 'text-violet-200' },
  amber: { ring: 'ring-amber-500/20', bg: 'from-amber-500/8', iconBg: 'bg-amber-500/15', iconText: 'text-amber-200' },
  emerald: { ring: 'ring-emerald-500/20', bg: 'from-emerald-500/8', iconBg: 'bg-emerald-500/15', iconText: 'text-emerald-200' },
  blue: { ring: 'ring-blue-500/20', bg: 'from-blue-500/8', iconBg: 'bg-blue-500/15', iconText: 'text-blue-200' },
  rose: { ring: 'ring-rose-500/20', bg: 'from-rose-500/8', iconBg: 'bg-rose-500/15', iconText: 'text-rose-200' },
};

function CapabilityCard({
  Icon,
  title,
  body,
  tone,
}: {
  Icon: LucideIcon;
  title: string;
  body: string;
  tone: keyof typeof TONE_CARD;
}) {
  const t = TONE_CARD[tone];
  return (
    <div
      className={`group rounded-xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} to-transparent p-5 ring-1 ${t.ring} transition-all hover:border-neutral-700`}
    >
      <div
        className={`flex h-9 w-9 items-center justify-center rounded-lg ${t.iconBg} ${t.iconText} ring-1 ring-inset ring-white/5`}
      >
        <Icon className="h-4 w-4" strokeWidth={2.25} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{body}</p>
    </div>
  );
}

// ============================================================================
// PERSONAS — three concrete user shapes the product was built for
// ============================================================================

function Personas() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">For who</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Built for teams that ship fast.{' '}
          <span className="text-neutral-400">Used by companies that need the receipts.</span>
        </h2>
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        <PersonaCard
          Icon={GitBranch}
          chip="Vibe-coded founder"
          title="You shipped a SaaS. The security team is &ldquo;future you.&rdquo;"
          bullets={[
            'Install the GitHub App on one repo',
            "Paste your prod URL — TensorShield scans it daily",
            'Findings land as PR comments + chat — no separate dashboard to refresh',
            'Auto-fix dep-CVEs once you trust the slider',
          ]}
          cta="Start free"
        />
        <PersonaCard
          Icon={ShieldCheck}
          chip="AppSec engineer"
          title="50-200 person company. You can&apos;t scan 30 repos manually."
          bullets={[
            'Register every asset once — cadence-driven scans run themselves',
            'Closed-loop suppression cuts your inbox by 80% within 2 weeks',
            'Per-team scopes (coming) keep noise out of the wrong channels',
            'Audit log + signed evidence chain for every scan',
          ]}
          cta="See pricing"
          ctaHref="/pricing"
        />
        <PersonaCard
          Icon={FileLock}
          chip="Compliance lead"
          title="Your auditor is asking. You don&apos;t want to update spreadsheets."
          bullets={[
            'Per-control verdicts ingested from every scan',
            'Living Trust Page replaces the static SOC 2 PDF',
            'Sharable evidence chain (HMAC-signed) for auditors',
            'Drop-in for the security-finding half of Vanta / Drata',
          ]}
          cta="Talk to us"
          ctaHref="/contact"
        />
      </div>
    </section>
  );
}

function PersonaCard({
  Icon,
  chip,
  title,
  bullets,
  cta,
  ctaHref = '/signup',
}: {
  Icon: LucideIcon;
  chip: string;
  title: string;
  bullets: string[];
  cta: string;
  ctaHref?: string;
}) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6">
      <div className="inline-flex items-center gap-2 self-start rounded-full border border-neutral-800 bg-neutral-950 px-2.5 py-1 text-[10.5px] font-medium text-neutral-300">
        <Icon className="h-3 w-3" strokeWidth={2.5} />
        {chip}
      </div>
      <h3
        className="mt-4 text-lg font-semibold leading-snug text-white"
        dangerouslySetInnerHTML={{ __html: title }}
      />
      <ul className="mt-4 flex-1 space-y-2 text-sm text-neutral-300">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-cyan-300" strokeWidth={2.25} />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <Link
        href={ctaHref}
        className="mt-6 inline-flex items-center gap-1.5 self-start rounded-lg border border-neutral-800 bg-neutral-950/60 px-3.5 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900"
      >
        {cta}
        <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
      </Link>
    </div>
  );
}

// ============================================================================
// HOW IT WORKS — what happens in your first week
// ============================================================================

function HowItWorks() {
  const steps: { n: number; title: string; body: string; Icon: LucideIcon }[] = [
    {
      n: 1,
      title: 'Create your workspace',
      body:
        '30 seconds. Your workspace gives you an isolated scan sandbox, an encrypted vault for credentials, and an evidence chain signed with your own key.',
      Icon: Lock,
    },
    {
      n: 2,
      title: 'Register assets',
      body:
        'Install the GitHub App on the repos that matter. Paste the production URL. Add domains for surface mapping. Each registered asset gets its own cadence.',
      Icon: TargetIcon,
    },
    {
      n: 3,
      title: 'First scan kicks off',
      body:
        'TensorShield runs in an isolated sandbox per scan. Findings stream live into your chat. PR comments land within the GitHub App\'s scope.',
      Icon: Activity,
    },
    {
      n: 4,
      title: 'Triage in chat — TensorShield remembers',
      body:
        'Dismiss with a reason. "Fix the critical." "What\'s open?" "How ready am I for SOC 2?" — TensorShield answers from your workspace. Continuous scans take over from here.',
      Icon: Brain,
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          How it works
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          From signup to continuous monitoring in one sitting.
        </h2>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <div
            key={s.n}
            className="relative rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-200 ring-1 ring-inset ring-white/5">
                <s.Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                step {s.n}
              </span>
            </div>
            <h3 className="mt-3.5 text-base font-semibold text-white">{s.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// COMPARISON — vs the categories TensorShield replaces
// ============================================================================

function ComparisonTable() {
  type Row = {
    label: string;
    Icon: LucideIcon;
    others: string;
    tensorshield: string;
  };
  const rows: Row[] = [
    {
      label: 'Signal shape',
      Icon: AlertTriangle,
      others: '300 findings, 285 noise',
      tensorshield: 'The 2 that matter today, surfaced in chat',
    },
    {
      label: 'Continuity',
      Icon: Clock,
      others: 'Quarterly pentests; stale on arrival',
      tensorshield: 'Continuous per-asset scans, every day',
    },
    {
      label: 'Learning',
      Icon: Brain,
      others: 'Same false positive re-flagged every scan',
      tensorshield: 'Dismiss once → rule with your reason on file',
    },
    {
      label: 'Where it lives',
      Icon: MessageSquare,
      others: 'A dashboard you have to refresh',
      tensorshield: 'Chat, PR comments, Slack — wherever your team works',
    },
    {
      label: 'Compliance evidence',
      Icon: FileLock,
      others: 'Vanta-style screenshot collection',
      tensorshield: 'Auto-collected per scan, live Trust Page',
    },
    {
      label: 'Autonomy',
      Icon: Zap,
      others: 'Click "Apply Fix" once at a time',
      tensorshield: 'Per-category slider: co-pilot ↔ autopilot',
    },
    {
      label: 'Your data',
      Icon: Lock,
      others: 'Pooled training, generic suppression heuristics',
      tensorshield: 'Your dismissals + decisions stay in your workspace',
    },
  ];

  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          The shape of the product
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          A different category than scanners or pentest tools.
        </h2>
        <p className="mt-3 text-base text-neutral-400">
          We&apos;re not a better Aikido or a smarter Snyk. TensorShield is what you&apos;d hire
          if a security engineer worked 24/7, never forgot, and lived inside your team&apos;s
          tools.
        </p>
      </div>
      <div className="mt-12 overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-900/30">
        <div className="grid grid-cols-[1.2fr_1.4fr_1.4fr] border-b border-neutral-800/80 bg-neutral-950/40 px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          <div></div>
          <div>Traditional tools</div>
          <div className="text-cyan-300">TensorShield</div>
        </div>
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={`grid grid-cols-[1.2fr_1.4fr_1.4fr] items-center gap-4 px-5 py-4 text-sm ${
              i % 2 === 0 ? 'bg-neutral-950/20' : ''
            } ${i < rows.length - 1 ? 'border-b border-neutral-800/40' : ''}`}
          >
            <div className="flex items-center gap-2.5 text-neutral-300">
              <r.Icon className="h-4 w-4 text-neutral-500" strokeWidth={2} />
              {r.label}
            </div>
            <div className="text-neutral-400">{r.others}</div>
            <div className="font-medium text-neutral-100">{r.tensorshield}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// FINAL CTA
// ============================================================================

function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="relative overflow-hidden rounded-3xl border border-neutral-800/80 bg-neutral-900/40 p-10 text-center lg:p-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(60% 60% at 50% 0%, rgba(6, 182, 212, 0.18) 0%, transparent 70%)',
          }}
        />
        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
            <Sparkles className="h-3 w-3" strokeWidth={2.5} />
            Hire TensorShield
          </div>
          <h2 className="mx-auto mt-5 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Sign up. Register your first asset.{' '}
            <span className="bg-gradient-to-br from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              Have a finding in 10 minutes.
            </span>
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
            5 free scans per month. Your workspace stays private. No credit card. Conversations
            you&apos;ll wish your real security engineer remembered.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
              <GitPullRequest className="h-4 w-4" strokeWidth={2} />
              Talk to us
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5" strokeWidth={2.5} />
              In-app chat
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5" strokeWidth={2.5} />
              Slack bridge
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" strokeWidth={2.5} />
              Public trust page
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1.5">
              <Repeat className="h-3.5 w-3.5" strokeWidth={2.5} />
              Continuous scanning
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
