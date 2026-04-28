import Link from 'next/link';
import {
  ShieldCheck,
  ArrowRight,
  Zap,
  Target,
  Sparkles,
  GitBranch,
  Activity,
  Lock,
  Code2,
  CheckCircle2,
  Bot,
  Eye,
  Ban,
  Code2 as GithubIcon,
  AlertTriangle,
  Flame,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Logos />
      <PainPoints />
      <Features />
      <AiTriageSpotlight />
      <HowItWorks />
      <FinalCta />
    </>
  );
}

// ============== HERO ==============

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 lg:pt-28 lg:pb-24">
      <div className="grid items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
            <Sparkles className="h-3 w-3" strokeWidth={2.5} />
            Powered by AI agents — built on the open-source Strix
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            AI hackers that find{' '}
            <span className="bg-gradient-to-br from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
              real
            </span>{' '}
            vulnerabilities in your apps.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-neutral-300">
            A multi-tenant SaaS layer over the Strix security agent. Scan repos and deployed apps,
            triage findings with built-in AI, and ship fixes — without drowning your team in false
            positives.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-3 text-sm font-semibold text-neutral-950 shadow-lg shadow-white/15 transition-all hover:shadow-xl hover:shadow-white/25"
            >
              Start scanning free
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-3 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
            >
              Sign in
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-400">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              Free tier
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              No credit card
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              Self-host with one Docker command
            </span>
          </div>
        </div>

        <div className="lg:col-span-5">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}

function HeroVisual() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-cyan-500/20 via-blue-500/10 to-violet-500/20 blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-950/80 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-center gap-1.5 border-b border-neutral-800/80 bg-neutral-900/60 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          <span className="ml-3 font-mono text-[10.5px] text-neutral-500">strix · live scan</span>
        </div>

        <div className="space-y-3 p-5">
          {/* Status row */}
          <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            <span className="font-semibold text-blue-200">RUNNING</span>
            <span className="text-blue-300">·</span>
            <span className="text-neutral-300">7 agents · 96 tools used</span>
          </div>

          {/* Mock finding card 1 */}
          <MockFinding
            severity="CRITICAL"
            stripe="from-red-500 to-rose-700"
            badge="bg-red-600/20 text-red-200 ring-red-500/40"
            urgencyBadge={{ label: 'AI · FIX NOW', color: 'bg-red-600/20 text-red-200 ring-red-500/40' }}
            Icon={Flame}
            iconColor="text-red-300"
            title="SSRF in Scan Target leading to Internal Service Scanning"
            cwe="CWE-918"
            cvss="8.5"
          />
          {/* Mock finding 2 */}
          <MockFinding
            severity="MEDIUM"
            stripe="from-yellow-500 to-amber-500"
            badge="bg-yellow-500/15 text-yellow-200 ring-yellow-400/40"
            urgencyBadge={{ label: 'AI · DISMISS', color: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40' }}
            Icon={Ban}
            iconColor="text-neutral-400"
            title="Hardcoded credentials in .env.example"
            cwe="CWE-798"
            cvss="—"
            dimmed
          />
        </div>
      </div>
    </div>
  );
}

function MockFinding({
  severity,
  stripe,
  badge,
  urgencyBadge,
  Icon,
  iconColor,
  title,
  cwe,
  cvss,
  dimmed,
}: {
  severity: string;
  stripe: string;
  badge: string;
  urgencyBadge: { label: string; color: string };
  Icon: LucideIcon;
  iconColor: string;
  title: string;
  cwe: string;
  cvss: string;
  dimmed?: boolean;
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40 ${dimmed ? 'opacity-70 saturate-50' : ''}`}
    >
      <div className={`h-[2px] bg-gradient-to-r ${stripe}`} />
      <div className="flex items-start gap-2.5 p-3">
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconColor}`} strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wider ring-1 ${urgencyBadge.color}`}>
              {urgencyBadge.label}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wider ring-1 ${badge}`}>
              {severity}
            </span>
            <span className="rounded bg-neutral-900/60 px-1.5 py-0.5 font-mono text-[8.5px] text-neutral-400 ring-1 ring-neutral-800">
              CVSS {cvss}
            </span>
            <span className="rounded bg-neutral-900/60 px-1.5 py-0.5 font-mono text-[8.5px] text-neutral-400 ring-1 ring-neutral-800">
              {cwe}
            </span>
          </div>
          <div className="mt-1.5 text-[12px] font-semibold leading-tight text-neutral-100">
            {title}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============== LOGOS / TRUST ==============

function Logos() {
  return (
    <section className="border-y border-neutral-900/60 bg-neutral-950/30 py-7">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs text-neutral-500">
          <span className="text-neutral-400">Built on the open-source</span>
          <a
            href="https://github.com/usestrix/strix"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-white"
          >
            <ShieldCheck className="h-3 w-3 text-cyan-400" />
            usestrix/strix
          </a>
          <span className="text-neutral-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
            LiteLLM-powered
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
            Postgres + RLS for tenant isolation
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
            Self-hostable
          </span>
        </div>
      </div>
    </section>
  );
}

// ============== PAIN POINTS ==============

function PainPoints() {
  const items: { Icon: LucideIcon; title: string; body: string }[] = [
    {
      Icon: AlertTriangle,
      title: 'Static scanners cry wolf',
      body: 'Your CI runs SAST and prints 300 findings. 285 are noise. Your team stops looking.',
    },
    {
      Icon: Eye,
      title: 'Manual pentests are slow',
      body: "Annual pentest reports arrive 6 months after the bug shipped. You're paying for a snapshot, not a process.",
    },
    {
      Icon: Bot,
      title: 'AI agents need adult supervision',
      body: 'A scanning agent that runs unsupervised and produces unverified reports just shifts the noise problem.',
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">The problem</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Security tooling has a signal-to-noise problem.
        </h2>
        <p className="mt-3 text-base text-neutral-400">
          Most app-sec teams spend more time triaging tools than fixing real bugs.
        </p>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-3">
        {items.map((it) => (
          <div
            key={it.title}
            className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5 transition-colors hover:border-neutral-700"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-900 text-neutral-400 ring-1 ring-inset ring-white/5">
              <it.Icon className="h-4 w-4" strokeWidth={2} />
            </div>
            <h3 className="mt-3 text-base font-semibold text-neutral-100">{it.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============== FEATURES ==============

function Features() {
  const items: {
    Icon: LucideIcon;
    title: string;
    body: string;
    tone: 'cyan' | 'violet' | 'amber' | 'emerald' | 'blue' | 'rose';
  }[] = [
    {
      Icon: Bot,
      title: 'Multi-agent scanning',
      body: 'Strix spins up specialized agents per surface — auth, business logic, IDOR, SQLi — and runs them in a Docker sandbox per scan.',
      tone: 'cyan',
    },
    {
      Icon: Sparkles,
      title: 'AI triage out of the box',
      body: 'A second LLM rates every finding for reachability and urgency. False positives get dismissed automatically. You only see what matters.',
      tone: 'violet',
    },
    {
      Icon: Activity,
      title: 'Live agent telemetry',
      body: "Watch every tool call, agent decision, and finding stream in real time. No more black-box 'scan in progress'.",
      tone: 'blue',
    },
    {
      Icon: Target,
      title: 'Targets as first-class assets',
      body: 'Scan a repo, app, or domain repeatedly. Findings de-dup by fingerprint and roll up per target — no alert fatigue from re-scans.',
      tone: 'emerald',
    },
    {
      Icon: Lock,
      title: 'Multi-tenant by design',
      body: 'Postgres RLS isolates every org. Integration secrets sit in Supabase Vault and only decrypt in the worker, just-in-time, audited.',
      tone: 'amber',
    },
    {
      Icon: GitBranch,
      title: 'Plugs into your stack',
      body: 'GitHub OAuth for white-box scans. AWS via STS-AssumeRole. Kubernetes via kubeconfig. GitLab, Azure, GCP — all standard flows.',
      tone: 'rose',
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">What you get</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          A scanner that thinks like an attacker.{' '}
          <span className="text-neutral-400">Triage that thinks like an engineer.</span>
        </h2>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <FeatureCard key={it.title} {...it} />
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

function FeatureCard({
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
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${t.iconBg} ${t.iconText} ring-1 ring-inset ring-white/5`}>
        <Icon className="h-4 w-4" strokeWidth={2.25} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{body}</p>
    </div>
  );
}

// ============== AI TRIAGE SPOTLIGHT ==============

function AiTriageSpotlight() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="overflow-hidden rounded-3xl border border-neutral-800/80 bg-gradient-to-br from-violet-500/10 via-neutral-950 to-cyan-500/10 p-8 lg:p-12">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-[11px] font-medium text-violet-200">
              <Sparkles className="h-3 w-3" strokeWidth={2.5} />
              The differentiator
            </div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              From <span className="text-neutral-500 line-through decoration-2">7 critical</span> to{' '}
              <span className="bg-gradient-to-br from-violet-300 to-cyan-300 bg-clip-text text-transparent">
                2 worth fixing
              </span>{' '}
              — automatically.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-neutral-300">
              Every finding gets a second-opinion review from a senior-engineer-class LLM that
              understands your codebase context. It rates reachability, exploit chain realism, and
              recommends an action. False positives get marked. Real bugs get prioritized.
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-neutral-300">
              <ListItem Icon={Zap} color="text-red-300" label="Fix now — real, reachable, high impact." />
              <ListItem Icon={Eye} color="text-amber-300" label="Monitor — needs human review or upstream change." />
              <ListItem Icon={Ban} color="text-neutral-400" label="Dismiss — likely false positive or dev-only." />
            </ul>
            <Link
              href="/signup"
              className="mt-7 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg shadow-white/15 transition-all hover:shadow-xl"
            >
              Try the free tier
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
            </Link>
          </div>
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-3 rounded-2xl bg-gradient-to-br from-violet-500/30 to-cyan-500/20 blur-2xl"
            />
            <div className="relative space-y-2 rounded-xl border border-neutral-800/80 bg-neutral-950/70 p-4 backdrop-blur">
              <TriageRow Icon={Zap} color="text-red-300" pill="bg-red-500/15 text-red-200 ring-red-500/40" tag="FIX NOW" title="SSRF in target validator" reasoning="Externally reachable to authenticated users. Concrete exploit chain to internal services." />
              <TriageRow Icon={Eye} color="text-amber-300" pill="bg-amber-500/15 text-amber-200 ring-amber-400/40" tag="MONITOR" title="RCE potential via instruction_text" reasoning="Real concern but mitigation requires upstream change. Track until patched." />
              <TriageRow Icon={Ban} color="text-neutral-400" pill="bg-neutral-700/40 text-neutral-300 ring-neutral-600/40" tag="DISMISS" title="Hardcoded credentials in .env.example" reasoning="Placeholder credentials in an example file. Not a real secret." dim />
              <TriageRow Icon={Ban} color="text-neutral-400" pill="bg-neutral-700/40 text-neutral-300 ring-neutral-600/40" tag="DISMISS" title="Email confirmation off in dev config" reasoning="Intentional dev-only setting; production deploys override." dim />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ListItem({ Icon, color, label }: { Icon: LucideIcon; color: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <Icon className={`h-4 w-4 flex-shrink-0 ${color}`} strokeWidth={2.25} />
      <span>{label}</span>
    </li>
  );
}

function TriageRow({
  Icon,
  color,
  pill,
  tag,
  title,
  reasoning,
  dim,
}: {
  Icon: LucideIcon;
  color: string;
  pill: string;
  tag: string;
  title: string;
  reasoning: string;
  dim?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-3 ${dim ? 'opacity-70 saturate-50' : ''}`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${color}`} strokeWidth={2.25} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ring-1 ${pill}`}>
              {tag}
            </span>
            <span className="truncate text-[12.5px] font-medium text-neutral-100">{title}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-400">{reasoning}</p>
        </div>
      </div>
    </div>
  );
}

// ============== HOW IT WORKS ==============

function HowItWorks() {
  const steps = [
    {
      n: 1,
      title: 'Add a target',
      body: 'Connect a GitHub repo, point at a deployed URL, or paste a domain. Targets are first-class — every scan rolls up here.',
      Icon: Target,
    },
    {
      n: 2,
      title: 'Run a scan',
      body: 'Pick quick / standard / deep. The agent clones the repo into a sandbox, plans the attack surface, and goes to work.',
      Icon: Activity,
    },
    {
      n: 3,
      title: 'Triage and fix',
      body: 'Findings stream in live, AI-triaged for urgency and reachability. Mark fixed inline. Re-runs dedup automatically.',
      Icon: CheckCircle2,
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">How it works</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Three steps from connected to triaged.
        </h2>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {steps.map((s) => {
          const Icon = s.Icon;
          return (
            <div
              key={s.n}
              className="relative rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-6"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-200 ring-1 ring-inset ring-white/5">
                  <Icon className="h-4 w-4" strokeWidth={2.25} />
                </div>
                <span className="font-mono text-xs text-neutral-500">step {s.n}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{s.body}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ============== FINAL CTA ==============

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
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Ship faster. Sleep better.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
            Spin up an org in 30 seconds. Scan your first repo in 3 minutes. No credit card.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-6 py-3 text-base font-semibold text-neutral-950 shadow-lg shadow-white/20 transition-all hover:shadow-xl"
            >
              Get started — it's free
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />
            </Link>
            <Link
              href="https://github.com/ClatTribe/webappsec"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-6 py-3 text-base font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
            >
              <Code2 className="h-4 w-4" />
              Self-host on GitHub
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

