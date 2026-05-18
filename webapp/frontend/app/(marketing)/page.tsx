import Link from 'next/link';
import {
  ArrowRight,
  Sparkles,
  Lock,
  CheckCircle2,
  MessageSquare,
  ShieldCheck,
  ShieldOff,
  Workflow,
  Brain,
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
  Code2,
  Globe,
  Cloud,
  Container,
  Network,
  Server,
  Webhook,
  Crosshair,
  FlaskConical,
  TrendingUp,
  Layers,
  Wand2,
  ScrollText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title:
    'TensorShield — AI security & compliance engineer for the whole stack',
  description:
    'Your code, your cloud, your APIs — TensorShield runs continuously across every attack surface, proves what is actually exploitable (not just what scanners flag), and assembles the audit evidence as it goes. Stop paying three vendors for one job.',
  path: '/',
  rawTitle: true,
});

export default function LandingPage() {
  return (
    <>
      <Hero />
      <ProofStrip />
      <AssetCoverage />
      <ProofItRail />
      <ClosedLoop />
      <ComplianceProduct />
      <Capabilities />
      <Personas />
      <ComparisonTable />
      <HowItWorks />
      <FinalCta />
    </>
  );
}

// ============================================================================
// HERO
// ============================================================================

function Hero() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 pt-20 pb-16 lg:pt-28 lg:pb-24">
      {/* Ambient gradient halo — pure CSS, no client JS */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[600px] opacity-60"
        style={{
          background:
            'radial-gradient(60% 50% at 50% 0%, rgba(6, 182, 212, 0.12) 0%, transparent 70%)',
        }}
      />
      <div className="grid items-center gap-12 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
            </span>
            AI security &amp; compliance engineer
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.02] tracking-tight text-white sm:text-5xl lg:text-[3.75rem]">
            Your stack has seven attack surfaces.{' '}
            <span className="bg-gradient-to-br from-cyan-300 via-blue-300 to-violet-300 bg-clip-text text-transparent">
              Your security team has one.
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-neutral-300">
            TensorShield is the AI security engineer you would hire if budget weren&apos;t in the way.
            It runs continuously across your code, cloud, web apps, APIs, containers, and
            dependencies — proves what&apos;s actually exploitable, and builds your audit
            evidence as it goes.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-3 text-sm font-semibold text-neutral-950 shadow-lg shadow-white/15 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-white/25"
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
              First proven exploit in &lt; 10 min
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
        className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-cyan-500/25 via-blue-500/15 to-violet-500/25 blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-950/85 shadow-2xl shadow-black/50 backdrop-blur">
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/60 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <span className="font-mono text-[10.5px] text-neutral-500">
            tensorshield.ai · your workspace
          </span>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <span className="text-[10px] text-neutral-400">live</span>
          </div>
        </div>

        {/* Chat thread */}
        <div className="space-y-4 p-5">
          <ChatMessage role="agent" timeAgo="9:02 AM">
            <p className="text-sm leading-relaxed text-neutral-100">
              <span className="font-semibold text-rose-300">Critical</span> · SQL injection at{' '}
              <code className="rounded bg-neutral-800/60 px-1 py-0.5 font-mono text-[11px]">
                /api/login
              </code>
            </p>
            <p className="mt-1.5 text-xs text-neutral-400">
              Reproduced against the live endpoint — I extracted{' '}
              <code className="font-mono">SELECT 1</code> through the username field. Drafted a
              parameterised-query fix on a branch.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill cyan>See exploit PoC</Pill>
              <Pill>Open fix PR</Pill>
              <Pill>Dismiss</Pill>
            </div>
          </ChatMessage>

          <ChatMessage role="user" timeAgo="9:03 AM">
            <p className="text-sm text-neutral-100">open the fix PR. also, am i SOC 2 ready?</p>
          </ChatMessage>

          <ChatMessage role="agent" timeAgo="9:03 AM">
            <p className="text-sm leading-relaxed text-neutral-100">
              ✓ <span className="text-cyan-300">PR #289</span> opened with a regression test.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
              SOC 2 readiness: <span className="text-emerald-300">81/100</span> (▲ 13 since Q1).
              19 of 24 controls pass · 2 warn · 3 fail. The 3 failures are all in CC6 — root
              account still has long-lived AWS access keys.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill cyan>Show me the 3 failures</Pill>
              <Pill>Share with auditor</Pill>
            </div>
          </ChatMessage>
        </div>

        {/* Composer */}
        <div className="border-t border-neutral-800/60 bg-neutral-900/40 px-4 py-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
              Ask TensorShield anything about your scans, findings, cloud posture, or compliance…
            </div>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/30">
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
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 shadow-md shadow-cyan-500/30">
            <Sparkles className="h-3.5 w-3.5 text-white" />
          </div>
        )}
      </div>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser ? 'bg-cyan-500/15 text-neutral-100' : 'bg-neutral-900/70 text-neutral-100'
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
      <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[10.5px] font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20">
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
    <span className="rounded-md border border-neutral-700 bg-neutral-800/60 px-2.5 py-1 text-[10.5px] text-neutral-200 transition-colors hover:bg-neutral-800/90">
      {children}
    </span>
  );
}

// ============================================================================
// PROOF STRIP
// ============================================================================

function ProofStrip() {
  const stats: { value: string; label: string }[] = [
    { value: '7', label: 'Attack surfaces under one agent' },
    { value: '5', label: 'Frameworks scored from one scan' },
    { value: '0', label: 'Re-flagging of dismissed patterns, ever' },
    { value: '24/7', label: 'Continuous monitoring across registered assets' },
  ];
  return (
    <section className="border-y border-neutral-900/60 bg-neutral-950/40 py-10">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className="bg-gradient-to-br from-cyan-300 to-blue-300 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
                {s.value}
              </div>
              <div className="mt-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
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
// ASSET COVERAGE — what we protect for each surface
// ============================================================================

interface SurfaceCoverage {
  Icon: LucideIcon;
  tone: 'cyan' | 'violet' | 'emerald' | 'amber' | 'blue' | 'rose' | 'fuchsia';
  surface: string;
  tagline: string;
  catches: string[];
  proof: string;
}

const SURFACES: SurfaceCoverage[] = [
  {
    Icon: Code2,
    tone: 'cyan',
    surface: 'Source code',
    tagline: 'SAST + SCA + secrets + IaC — every layer of your repository.',
    catches: [
      'SQL injection',
      'XSS · RCE · SSRF',
      'Hardcoded secrets',
      'Weak crypto',
      'Insecure deserialisation',
      'Dependency CVEs (with reachability)',
      'IaC misconfig',
      'Custom Semgrep rules',
    ],
    proof: 'Reachability scoring — a CVE in code that never runs is not your problem.',
  },
  {
    Icon: Globe,
    tone: 'violet',
    surface: 'Web applications',
    tagline: 'Black-box DAST that drives a real browser and verifies every critical.',
    catches: [
      'SQL injection (PoC)',
      'XSS (reflected · stored · DOM)',
      'IDOR & broken access',
      'Auth bypass',
      'CSRF',
      'Open redirects',
      'Business-logic flaws',
      'Session / JWT issues',
    ],
    proof: 'Every high finds a working exploit before it reaches your inbox.',
  },
  {
    Icon: Webhook,
    tone: 'amber',
    surface: 'APIs',
    tagline: 'OpenAPI-aware. The attacks scanners miss because they need context.',
    catches: [
      'BOLA',
      'Mass assignment',
      'Broken authentication',
      'Rate-limit gaps',
      'Server-side request forgery',
      'GraphQL introspection abuse',
      'API key leaks in responses',
      'Spec drift',
    ],
    proof: 'Authenticates as a real user before testing — finds what unauth scanners can\'t.',
  },
  {
    Icon: Cloud,
    tone: 'blue',
    surface: 'Cloud accounts',
    tagline: 'Attack-path graph: external principal → resource. AWS / GCP / Azure.',
    catches: [
      'Public storage exposure',
      'IAM sprawl (root keys, admin users)',
      'Missing encryption at rest',
      'Cross-account trust chains',
      'Network exposure (open SGs / firewalls)',
      'IaC drift vs deployed state',
      'Unattached resources',
    ],
    proof: 'A single open S3 bucket is not the finding. The chain to PII is.',
  },
  {
    Icon: Container,
    tone: 'emerald',
    surface: 'Container images',
    tagline: 'Layer-by-layer scan with secret discovery + base-image health.',
    catches: [
      'OS package CVEs',
      'Vulnerable base images',
      'Secret leaks in layers',
      'Dockerfile anti-patterns',
      'Excessive privileges',
      'Outdated runtimes',
    ],
    proof: 'Same fingerprint family as code — one finding, one fix, every image affected.',
  },
  {
    Icon: Network,
    tone: 'fuchsia',
    surface: 'Domains & surface',
    tagline: 'Passive recon — see what the outside world sees of you.',
    catches: [
      'Subdomain enumeration',
      'DNS hygiene (SPF · DKIM · DMARC · DNSSEC)',
      'Expired certificates',
      'Exposed admin panels',
      'Email security (BIMI · MTA-STS)',
      'Shadow-IT discovery',
    ],
    proof: 'Driven from cert-transparency logs — comprehensive without DNS probes.',
  },
  {
    Icon: Server,
    tone: 'rose',
    surface: 'IP & infrastructure',
    tagline: 'Port-level recon and certificate hygiene across registered IP space.',
    catches: [
      'Exposed services',
      'TLS / SSL hygiene',
      'Service fingerprinting',
      'Known service CVEs',
      'Infrastructure drift',
      'Outdated SSH / RDP',
    ],
    proof: 'Catches the staging port someone forgot was open in 2023.',
  },
];

function AssetCoverage() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
          Coverage
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Connect your production stack.{' '}
          <span className="text-neutral-400">We protect every surface.</span>
        </h2>
        <p className="mt-4 text-base leading-relaxed text-neutral-400">
          Paste your prod URL, connect AWS / GitHub / a domain — TensorShield discovers what
          you have and starts continuous monitoring. Below is what we catch on each surface.
        </p>
      </div>

      {/* Quick chip rail — visual summary that mirrors the cards below */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
        {SURFACES.map((s) => (
          <a
            key={s.surface}
            href={`#surface-${s.surface.toLowerCase().replace(/[^a-z]/g, '-')}`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-all hover:-translate-y-0.5 ${TONE_CHIP[s.tone]}`}
          >
            <s.Icon className="h-3 w-3" strokeWidth={2.5} />
            {s.surface}
          </a>
        ))}
      </div>

      {/* Deep coverage cards — one per surface, two columns on lg+ */}
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {SURFACES.map((s) => (
          <SurfaceCard key={s.surface} surface={s} />
        ))}
      </div>
    </section>
  );
}

const TONE_CHIP: Record<SurfaceCoverage['tone'], string> = {
  cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15',
  emerald:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/15',
  rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15',
  fuchsia:
    'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/15',
};

const TONE_CARD: Record<SurfaceCoverage['tone'], { ring: string; bg: string; icon: string; text: string }> = {
  cyan: {
    ring: 'ring-cyan-500/20 hover:ring-cyan-500/40',
    bg: 'from-cyan-500/10',
    icon: 'bg-cyan-500/15 text-cyan-200',
    text: 'text-cyan-200',
  },
  violet: {
    ring: 'ring-violet-500/20 hover:ring-violet-500/40',
    bg: 'from-violet-500/10',
    icon: 'bg-violet-500/15 text-violet-200',
    text: 'text-violet-200',
  },
  emerald: {
    ring: 'ring-emerald-500/20 hover:ring-emerald-500/40',
    bg: 'from-emerald-500/10',
    icon: 'bg-emerald-500/15 text-emerald-200',
    text: 'text-emerald-200',
  },
  amber: {
    ring: 'ring-amber-500/20 hover:ring-amber-500/40',
    bg: 'from-amber-500/10',
    icon: 'bg-amber-500/15 text-amber-200',
    text: 'text-amber-200',
  },
  blue: {
    ring: 'ring-blue-500/20 hover:ring-blue-500/40',
    bg: 'from-blue-500/10',
    icon: 'bg-blue-500/15 text-blue-200',
    text: 'text-blue-200',
  },
  rose: {
    ring: 'ring-rose-500/20 hover:ring-rose-500/40',
    bg: 'from-rose-500/10',
    icon: 'bg-rose-500/15 text-rose-200',
    text: 'text-rose-200',
  },
  fuchsia: {
    ring: 'ring-fuchsia-500/20 hover:ring-fuchsia-500/40',
    bg: 'from-fuchsia-500/10',
    icon: 'bg-fuchsia-500/15 text-fuchsia-200',
    text: 'text-fuchsia-200',
  },
};

function SurfaceCard({ surface }: { surface: SurfaceCoverage }) {
  const t = TONE_CARD[surface.tone];
  const slug = surface.surface.toLowerCase().replace(/[^a-z]/g, '-');
  return (
    <article
      id={`surface-${slug}`}
      className={`group flex flex-col rounded-2xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} to-transparent p-6 ring-1 transition-all duration-200 hover:-translate-y-0.5 ${t.ring}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${t.icon} ring-1 ring-inset ring-white/5`}
        >
          <surface.Icon className="h-4.5 w-4.5" strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{surface.surface}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-neutral-400">
            {surface.tagline}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {surface.catches.map((c) => (
          <span
            key={c}
            className="rounded-md bg-neutral-900/70 px-2 py-1 text-[10.5px] text-neutral-300 ring-1 ring-inset ring-neutral-800/80 transition-colors group-hover:bg-neutral-900"
          >
            {c}
          </span>
        ))}
      </div>

      <div
        className={`mt-4 flex items-start gap-2 border-t border-neutral-800/60 pt-3 text-[11.5px] leading-relaxed ${t.text}`}
      >
        <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0" strokeWidth={2.5} />
        <span>{surface.proof}</span>
      </div>
    </article>
  );
}

// ============================================================================
// PROOF IT — we don't just flag, we prove
// ============================================================================

function ProofItRail() {
  return (
    <section className="relative border-y border-neutral-900/60 bg-gradient-to-b from-neutral-950/50 to-neutral-950 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-violet-300/80">
            Depth
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            We don&apos;t just flag.{' '}
            <span className="bg-gradient-to-br from-violet-300 to-cyan-300 bg-clip-text text-transparent">
              We prove.
            </span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-neutral-400">
            Scanners ship you a backlog of &ldquo;potentially exploitable&rdquo; pattern matches.
            TensorShield runs a verification pipeline against every high-severity finding before
            it reaches your inbox.
          </p>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          <ProofItCard
            Icon={FlaskConical}
            tone="violet"
            chip="Live exploit verification"
            title="Every critical gets a working PoC — or it gets downgraded."
            body="For each candidate vulnerability, an agent builds the exploit, runs it against your real (sandboxed) target, and only escalates if it succeeded. The flag you see has receipts."
          />
          <ProofItCard
            Icon={Crosshair}
            tone="cyan"
            chip="Reachability scoring"
            title="A dep CVE you don't import is not your problem."
            body="For SCA and SAST, we trace whether the vulnerable code is actually invoked by your application. Unreachable findings get a chip so they don't crowd out the ones that matter."
          />
          <ProofItCard
            Icon={Network}
            tone="emerald"
            chip="Cloud attack-path graph"
            title="A single open S3 bucket is not the finding. The chain is."
            body="The cloud scanner builds a graph: external principal → role assumption → resource access → data sensitivity. You see the attack as a path, not as 47 disconnected misconfigurations."
          />
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-neutral-500">
          Result: the average team sees{' '}
          <span className="text-neutral-200">10–20 real findings</span> in the first scan instead
          of a dump of 300 lines they&apos;ll never triage.
        </p>
      </div>
    </section>
  );
}

function ProofItCard({
  Icon,
  tone,
  chip,
  title,
  body,
}: {
  Icon: LucideIcon;
  tone: 'cyan' | 'violet' | 'emerald';
  chip: string;
  title: string;
  body: string;
}) {
  const t = {
    cyan: {
      ring: 'ring-cyan-500/30 hover:ring-cyan-500/50',
      bg: 'from-cyan-500/10',
      chipBg: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/30',
    },
    violet: {
      ring: 'ring-violet-500/30 hover:ring-violet-500/50',
      bg: 'from-violet-500/10',
      chipBg: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
    },
    emerald: {
      ring: 'ring-emerald-500/30 hover:ring-emerald-500/50',
      bg: 'from-emerald-500/10',
      chipBg: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    },
  }[tone];
  return (
    <div
      className={`rounded-2xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} to-transparent p-6 ring-1 transition-all duration-200 hover:-translate-y-1 ${t.ring}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border ${t.chipBg} px-2.5 py-1 text-[10.5px] font-medium`}
        >
          <Icon className="h-3 w-3" strokeWidth={2.5} />
          {chip}
        </span>
      </div>
      <h3 className="mt-4 text-lg font-semibold leading-snug text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">{body}</p>
    </div>
  );
}

// ============================================================================
// CLOSED LOOP — the moat
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
          Every scanner you&apos;ve used re-flags the same false positive every week. TensorShield
          turns each dismissal into a rule with your reason on file. The next scan that would&apos;ve
          flagged the same fingerprint? Suppressed — with a chat note citing the rule and the date.
        </p>
      </div>

      <div className="mt-14 grid items-start gap-4 lg:grid-cols-3">
        <LoopStep
          n={1}
          tone="amber"
          title="TensorShield finds it"
          chip="Low · Missing X-Frame-Options"
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
          chip="Suppressed · Missing X-Frame-Options on /pricing"
          quote='Your rule from 4 days ago covers this (dismissed 3 times, "Behind Cloudflare WAF").'
        />
      </div>

      <p className="mx-auto mt-12 max-w-xl text-center text-sm text-neutral-500">
        Your dismissal lives in your workspace. Rules apply only to your assets and are verifiable
        in every scan&apos;s audit trail. No pooled training — your decisions stay yours.
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
      className={`rounded-2xl border border-neutral-800/80 bg-gradient-to-b ${toneClass.bg} to-transparent p-5 ring-1 ${toneClass.ring} ${wide ? 'max-w-md' : ''} transition-all hover:-translate-y-0.5`}
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
// COMPLIANCE PRODUCT
// ============================================================================

function ComplianceProduct() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="grid gap-12 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-300/80">
            Compliance
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Compliance as a product.{' '}
            <span className="text-neutral-400">Not a spreadsheet.</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-neutral-300">
            Every scan emits per-control evidence across SOC 2, ISO 27001, PCI DSS 4.0, HIPAA,
            and NIST 800-53. Continuous collectors poll GitHub, AWS, GCP, and Okta for the
            org-level controls auditors actually ask about — MFA enforcement, key rotation,
            admin sprawl. One observation credits every framework it maps to.
          </p>
          <ul className="mt-6 space-y-2.5 text-sm text-neutral-300">
            <ComplianceBullet text="Per-control verdicts ingested from every scan and posted to a live readiness score." />
            <ComplianceBullet text="Continuous evidence collectors for GitHub, AWS IAM, GCP IAM, Okta — set once, runs forever." />
            <ComplianceBullet text="One observation credits five frameworks via cross-framework mappings — no duplicate work." />
            <ComplianceBullet text="Public Trust Page for prospects. Time-bounded auditor portal with JSON export for the rest." />
            <ComplianceBullet text="SBOM export in CycloneDX or SPDX for procurement diligence." />
            <ComplianceBullet text="Tamper-evident HMAC signature chain on every scan&apos;s evidence." />
          </ul>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-md transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              Try free
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60"
            >
              Talk to compliance
            </Link>
          </div>
        </div>

        <div className="lg:col-span-7">
          <ReadinessMockup />
        </div>
      </div>
    </section>
  );
}

function ComplianceBullet({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300"
        strokeWidth={2.25}
      />
      <span dangerouslySetInnerHTML={{ __html: text }} />
    </li>
  );
}

function ReadinessMockup() {
  const frameworks: { name: string; score: number; delta: number; quarters: number[] }[] = [
    { name: 'SOC 2', score: 81, delta: 13, quarters: [42, 55, 68, 81] },
    { name: 'ISO 27001', score: 76, delta: 8, quarters: [51, 60, 68, 76] },
    { name: 'PCI DSS 4.0', score: 65, delta: 22, quarters: [28, 38, 53, 65] },
    { name: 'HIPAA', score: 88, delta: 4, quarters: [78, 82, 84, 88] },
  ];
  const controls: { fw: string; id: string; verdict: 'pass' | 'fail' | 'warn'; label: string }[] = [
    { fw: 'SOC 2', id: 'CC6.1', verdict: 'pass', label: 'MFA enforced on every console user' },
    { fw: 'SOC 2', id: 'CC6.3', verdict: 'fail', label: 'Root AWS user has long-lived access keys' },
    { fw: 'PCI 4.0', id: '8.3', verdict: 'warn', label: 'Password policy missing symbol requirement' },
  ];

  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-amber-500/20 via-cyan-500/15 to-violet-500/20 blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-neutral-950/85 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/60 px-4 py-2.5">
          <div className="flex items-center gap-2 text-[11px] font-mono text-neutral-400">
            <ScrollText className="h-3.5 w-3.5" />
            audit share · acme corp · expires in 28 days
          </div>
          <span className="text-[10px] text-neutral-500">read-only</span>
        </div>
        <div className="space-y-5 p-5">
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
              <TrendingUp className="h-3 w-3" />
              Readiness trend · last 4 quarters
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {frameworks.map((f) => (
                <div
                  key={f.name}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 transition-colors hover:border-neutral-700"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[11px] text-neutral-300">{f.name}</span>
                    <span className="text-xl font-semibold text-neutral-100">{f.score}</span>
                  </div>
                  <div className="text-[9.5px] text-emerald-300">▲ {f.delta} since Q1</div>
                  <div className="mt-2 flex items-end gap-1">
                    {f.quarters.map((q, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-sm bg-cyan-500/30"
                        style={{ height: `${Math.max(3, (q / 100) * 24)}px` }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-neutral-500">
              <Layers className="h-3 w-3" />
              Live control verdicts · cross-framework
            </div>
            <div className="space-y-1.5">
              {controls.map((c) => (
                <div
                  key={`${c.fw}-${c.id}`}
                  className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2"
                >
                  <VerdictDot verdict={c.verdict} />
                  <code className="font-mono text-[10.5px] text-neutral-300">
                    {c.fw}:{c.id}
                  </code>
                  <span className="text-[12px] text-neutral-200">{c.label}</span>
                  <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[8.5px] text-cyan-200 ring-1 ring-cyan-500/30">
                    +4 frameworks
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VerdictDot({ verdict }: { verdict: 'pass' | 'fail' | 'warn' }) {
  const tone =
    verdict === 'pass'
      ? 'bg-emerald-400'
      : verdict === 'fail'
        ? 'bg-rose-400'
        : 'bg-amber-400';
  return <span className={`h-2 w-2 rounded-full ${tone}`} />;
}

// ============================================================================
// CAPABILITIES
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
        'Ask "what was the SSRF we found last quarter?" or "how ready am I for SOC 2?" — answered from your workspace memory, with citations to scans and findings.',
      tone: 'cyan',
    },
    {
      Icon: Activity,
      title: 'Continuous scanning, not on-demand',
      body:
        'Register an asset with a cadence. Daily, weekly, or on-push. Drift gets flagged the moment it lands — no dashboard to refresh.',
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
      Icon: Wand2,
      title: 'Custom rules per workspace',
      body:
        'Author your own Semgrep rules for stack-specific patterns — framework misuse, internal naming, deprecated APIs. They run alongside the built-in pack.',
      tone: 'violet',
    },
    {
      Icon: FileLock,
      title: 'Compliance as a living document',
      body:
        'SOC 2, ISO 27001, PCI DSS 4.0, HIPAA, NIST 800-53 — evidence collected continuously. Live Trust Page for prospects. Read-only auditor portal with JSON export.',
      tone: 'amber',
    },
    {
      Icon: Workflow,
      title: 'Autonomy slider per category',
      body:
        '&ldquo;Auto-fix critical dep-CVEs but ask me on medium.&rdquo; Tell TensorShield in chat. The slider scales with your trust — no clicking &ldquo;Apply Fix&rdquo; 47 times.',
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
          One agent.{' '}
          <span className="text-neutral-400">Five surfaces. One memory.</span>
        </h2>
        <p className="mt-3 text-base text-neutral-400">
          Chat, GitHub PR comments, Slack, the public Trust Page, the API — TensorShield speaks
          everywhere your team works. The same memory and the same rules apply across all of them.
        </p>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <CapabilityCard key={it.title} {...it} />
        ))}
      </div>
    </section>
  );
}

const TONE_CAPABILITY: Record<string, { ring: string; bg: string; iconBg: string; iconText: string }> = {
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
  tone: keyof typeof TONE_CAPABILITY;
}) {
  const t = TONE_CAPABILITY[tone];
  return (
    <div
      className={`group rounded-xl border border-neutral-800/80 bg-gradient-to-b ${t.bg} to-transparent p-5 ring-1 ${t.ring} transition-all duration-200 hover:-translate-y-1 hover:border-neutral-700`}
    >
      <div
        className={`flex h-9 w-9 items-center justify-center rounded-lg ${t.iconBg} ${t.iconText} ring-1 ring-inset ring-white/5 transition-transform group-hover:scale-110`}
      >
        <Icon className="h-4 w-4" strokeWidth={2.25} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p
        className="mt-1.5 text-sm leading-relaxed text-neutral-400"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}

// ============================================================================
// PERSONAS
// ============================================================================

function Personas() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">For who</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Built for teams that ship fast.{' '}
          <span className="text-neutral-400">
            Used by the ones that need the receipts.
          </span>
        </h2>
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        <PersonaCard
          Icon={GitBranch}
          chip="Founder / first engineer"
          title="You shipped a SaaS. &ldquo;Security&rdquo; is future you."
          bullets={[
            'Install the GitHub App on one repo, paste your prod URL',
            'Findings land as PR comments + chat — no dashboard to refresh',
            'Trust Page goes live the first time you pass a control',
            'Auto-fix dep-CVEs once you trust the autonomy slider',
          ]}
          cta="Start free"
        />
        <PersonaCard
          Icon={ShieldCheck}
          chip="AppSec / Security engineer"
          title="50–500 person org. Three scanners. None of them learn."
          bullets={[
            'Register every asset once — cadence-driven scans run themselves',
            'Closed-loop suppression cuts your inbox 80% in two weeks',
            'Cloud attack-path graph replaces 47 disconnected CSPM rows',
            'Per-team workspaces; signed audit trail per scan',
          ]}
          cta="See pricing"
          ctaHref="/pricing"
        />
        <PersonaCard
          Icon={FileLock}
          chip="Compliance / GRC lead"
          title="Your auditor is asking. You don&apos;t want to update spreadsheets."
          bullets={[
            'Per-control verdicts across SOC 2 / ISO / PCI / HIPAA / NIST',
            'Continuous collectors for GitHub, AWS, GCP, Okta — no manual screenshots',
            'Read-only auditor portal with JSON export — share, then revoke',
            'Quarterly readiness snapshots show the improvement narrative',
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
    <div className="flex h-full flex-col rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 transition-all duration-200 hover:-translate-y-1 hover:border-neutral-700 hover:bg-neutral-900/50">
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
        className="mt-6 inline-flex items-center gap-1.5 self-start rounded-lg border border-neutral-800 bg-neutral-950/60 px-3.5 py-2 text-xs font-medium text-neutral-200 transition-all hover:-translate-y-0.5 hover:border-neutral-700 hover:bg-neutral-900"
      >
        {cta}
        <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
      </Link>
    </div>
  );
}

// ============================================================================
// COMPARISON
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
      label: 'Coverage',
      Icon: Layers,
      others: 'One product per surface (SAST, DAST, CSPM, SCA)',
      tensorshield: 'Seven surfaces under one workspace and one memory',
    },
    {
      label: 'Signal shape',
      Icon: AlertTriangle,
      others: '300 findings, 285 noise',
      tensorshield: 'The 10–20 that have a verified exploit, surfaced in chat',
    },
    {
      label: 'Severity claim',
      Icon: FlaskConical,
      others: 'CVSS rating from a static rule',
      tensorshield: 'Live PoC built and run before the finding lands',
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
      tensorshield: 'Auto-collected per scan, live readiness score, auditor portal',
    },
    {
      label: 'Autonomy',
      Icon: Zap,
      others: 'Click &ldquo;Apply Fix&rdquo; one at a time',
      tensorshield: 'Per-category slider: co-pilot ↔ autopilot',
    },
    {
      label: 'Your data',
      Icon: Lock,
      others: 'Pooled training, generic suppression heuristics',
      tensorshield: 'Per-workspace memory and rules — nothing leaves your org',
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
          We&apos;re not a better Snyk, a smarter Wiz, or a leaner Vanta. TensorShield is what
          you&apos;d hire if a security engineer worked 24/7, never forgot, and lived inside your
          team&apos;s tools.
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
            className={`grid grid-cols-[1.2fr_1.4fr_1.4fr] items-center gap-4 px-5 py-4 text-sm transition-colors hover:bg-neutral-900/40 ${
              i % 2 === 0 ? 'bg-neutral-950/20' : ''
            } ${i < rows.length - 1 ? 'border-b border-neutral-800/40' : ''}`}
          >
            <div className="flex items-center gap-2.5 text-neutral-300">
              <r.Icon className="h-4 w-4 text-neutral-500" strokeWidth={2} />
              {r.label}
            </div>
            <div
              className="text-neutral-400"
              dangerouslySetInnerHTML={{ __html: r.others }}
            />
            <div className="font-medium text-neutral-100">{r.tensorshield}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// HOW IT WORKS
// ============================================================================

function HowItWorks() {
  const steps: { n: number; title: string; body: string; Icon: LucideIcon }[] = [
    {
      n: 1,
      title: 'Create your workspace',
      body:
        '30 seconds. Each workspace gets an isolated scan sandbox, an encrypted vault for credentials, and an evidence chain signed with your own key.',
      Icon: Lock,
    },
    {
      n: 2,
      title: 'Connect your stack',
      body:
        'Install the GitHub App. Paste production URLs. Connect AWS, GCP, or Azure. Add domains, container registries, OpenAPI specs. We auto-discover what you have.',
      Icon: TargetIcon,
    },
    {
      n: 3,
      title: 'First scans run end-to-end',
      body:
        'Each scan runs in its own sandbox. Every critical-severity finding gets a verified exploit attempt before it reaches you. PR comments land in scope.',
      Icon: Activity,
    },
    {
      n: 4,
      title: 'Triage in chat — and let it learn',
      body:
        'Dismiss with a reason. &ldquo;Fix the critical.&rdquo; &ldquo;How ready am I for SOC 2?&rdquo; — answered from your workspace memory. Continuous scans take over from here.',
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
            className="group relative rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5 transition-all duration-200 hover:-translate-y-1 hover:border-neutral-700"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 text-cyan-200 ring-1 ring-inset ring-white/5 transition-transform group-hover:scale-110">
                <s.Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                step {s.n}
              </span>
            </div>
            <h3 className="mt-3.5 text-base font-semibold text-white">{s.title}</h3>
            <p
              className="mt-1.5 text-sm leading-relaxed text-neutral-400"
              dangerouslySetInnerHTML={{ __html: s.body }}
            />
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
            Stop paying for noise.{' '}
            <span className="bg-gradient-to-br from-cyan-300 to-violet-300 bg-clip-text text-transparent">
              Have a proven finding in 10 minutes.
            </span>
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-neutral-300">
            5 free scans per month. Your workspace stays private. No credit card. One agent across
            every attack surface you ship to.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-white to-neutral-200 px-6 py-3 text-base font-semibold text-neutral-950 shadow-lg shadow-white/20 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl"
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
              <ShieldOff className="h-3.5 w-3.5" strokeWidth={2.5} />
              Reachability scoring
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
