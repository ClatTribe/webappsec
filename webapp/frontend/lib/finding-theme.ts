// Centralised visual tokens for findings + AI elements. The findings page
// surface (filter, card, drawer) and any other component that wants to
// match the same severity / urgency / status colour story should pull from
// here so refinements happen in one place.
//
// Design intent (AI-native security product, dark base):
//   - One signal per concept. Don't repeat severity in three places — pick
//     the strongest channel (left-edge band) and lean on it.
//   - Refined severity ramp: rose / orange / amber / emerald / zinc. Avoids
//     the "lime → red flat alert palette" most SAST tools use.
//   - Cyan→violet AI gradient as the unique brand mark — used only for
//     AI-driven elements (assessments, sub-agent cards, the "Brief" rail).
//   - High whitespace; visual rhythm comes from typography, not borders.

import {
  AlertTriangle,
  Flame,
  AlertCircle,
  Info,
  CircleDot,
  CheckCircle2,
  XCircle,
  Eye,
  Zap,
  Clock,
  Eye as EyeIcon,
  Ban,
  Globe,
  Lock,
  ShieldOff,
  Bug,
  Database,
  Mail,
  Network,
  Key,
  Package,
  KeyRound,
  Code2,
  Server,
  Files,
  Link2,
  Repeat,
  Eye as EyeOpen,
  HelpCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AiReachability,
  AiUrgency,
  FindingStatus,
  Severity,
} from '@/lib/supabase/types';

// ---------------------------------------------------------------------------
// Severity — communicated primarily by the left-edge band on the card.
// ---------------------------------------------------------------------------

export interface SeverityTheme {
  Icon: LucideIcon;
  /** Tailwind colour class for the icon dot. */
  iconColor: string;
  /** A tinted background for the small icon disc. */
  iconBg: string;
  /** The vertical band on the card's left edge — the *single* severity signal. */
  band: string;
  /** Label used inside the small inline severity chip when needed. */
  label: string;
}

export const SEVERITY_THEME: Record<Severity, SeverityTheme> = {
  critical: {
    Icon: Flame,
    iconColor: 'text-rose-300',
    iconBg: 'bg-rose-500/15',
    band: 'bg-gradient-to-b from-rose-500 to-red-600',
    label: 'Critical',
  },
  high: {
    Icon: AlertTriangle,
    iconColor: 'text-orange-300',
    iconBg: 'bg-orange-500/15',
    band: 'bg-gradient-to-b from-orange-500 to-amber-600',
    label: 'High',
  },
  medium: {
    Icon: AlertCircle,
    iconColor: 'text-amber-300',
    iconBg: 'bg-amber-500/15',
    band: 'bg-gradient-to-b from-amber-400 to-amber-500',
    label: 'Medium',
  },
  low: {
    Icon: CircleDot,
    iconColor: 'text-emerald-300',
    iconBg: 'bg-emerald-500/15',
    band: 'bg-gradient-to-b from-emerald-400 to-emerald-500',
    label: 'Low',
  },
  info: {
    Icon: Info,
    iconColor: 'text-zinc-400',
    iconBg: 'bg-zinc-500/15',
    band: 'bg-zinc-700',
    label: 'Info',
  },
};

// ---------------------------------------------------------------------------
// Urgency — the *action* the user should take. Always visible on a card.
// ---------------------------------------------------------------------------

export interface UrgencyTheme {
  label: string;
  pill: string;
  Icon: LucideIcon;
  /** Short tooltip-style copy explaining what this urgency means. */
  intent: string;
}

export const URGENCY_THEME: Record<AiUrgency, UrgencyTheme> = {
  fix_now: {
    label: 'Fix now',
    pill: 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-500/30',
    Icon: Zap,
    intent: 'AI flags this as urgent — confirmed real and reachable.',
  },
  fix_soon: {
    label: 'Fix soon',
    pill: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-400/30',
    Icon: Clock,
    intent: 'AI flags this as real but not immediately critical.',
  },
  monitor: {
    label: 'Monitor',
    pill: 'bg-blue-500/15 text-blue-200 ring-1 ring-blue-400/30',
    Icon: EyeIcon,
    intent: 'AI says: needs human review or upstream change.',
  },
  dismiss: {
    label: 'Dismiss',
    pill: 'bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-600/40',
    Icon: Ban,
    intent: 'AI assessed this as a likely false positive.',
  },
};

// ---------------------------------------------------------------------------
// Reachability — small chip used inside the expanded view.
// ---------------------------------------------------------------------------

export const REACHABILITY_THEME: Record<
  AiReachability,
  { label: string; Icon: LucideIcon; color: string }
> = {
  external_unauthenticated: { label: 'Public — no auth', Icon: Globe, color: 'text-rose-300' },
  external_authenticated: { label: 'Any signed-in user', Icon: Globe, color: 'text-orange-300' },
  internal_only: { label: 'Internal / privileged', Icon: Lock, color: 'text-amber-300' },
  unreachable: { label: 'Unreachable', Icon: ShieldOff, color: 'text-zinc-400' },
};

// ---------------------------------------------------------------------------
// Status — small subdued indicator. Shouldn't fight for attention with
// severity or urgency.
// ---------------------------------------------------------------------------

export const STATUS_THEME: Record<
  FindingStatus,
  { label: string; pill: string; Icon: LucideIcon }
> = {
  open: {
    label: 'Open',
    pill: 'bg-blue-500/10 text-blue-200 ring-1 ring-blue-400/30',
    Icon: AlertCircle,
  },
  triaged_real: {
    label: 'Confirmed',
    pill: 'bg-amber-500/10 text-amber-200 ring-1 ring-amber-400/30',
    Icon: Eye,
  },
  fixed: {
    label: 'Fixed',
    pill: 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30',
    Icon: CheckCircle2,
  },
  false_positive: {
    label: 'False positive',
    pill: 'bg-zinc-700/50 text-zinc-300 ring-1 ring-zinc-600/40',
    Icon: XCircle,
  },
  wont_fix: {
    label: "Won't fix",
    pill: 'bg-zinc-700/50 text-zinc-300 ring-1 ring-zinc-600/40',
    Icon: XCircle,
  },
  dismissed_by_ai: {
    // Distinct from `false_positive` (user policy). Picks up the cyan
    // AI brand colour so a user scanning the list can tell at a glance
    // which dismissals were system-driven and reversible.
    label: 'AI dismissed',
    pill: 'bg-cyan-500/10 text-cyan-200 ring-1 ring-cyan-500/30',
    Icon: Ban,
  },
};

// ---------------------------------------------------------------------------
// AI brand mark — a single source for the cyan→violet gradient we use on
// AI-driven elements. Anything that isn't AI shouldn't use this.
// ---------------------------------------------------------------------------

export const AI_BRAND = {
  /** Use as `className={AI_BRAND.gradientText}` for headings / labels. */
  gradientText:
    'bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent',
  /** Subtle background tint for AI cards / banners. */
  bgTint: 'bg-gradient-to-r from-cyan-500/[0.04] via-sky-500/[0.04] to-violet-500/[0.04]',
  /** Border tint that pairs with bgTint. */
  ring: 'ring-1 ring-cyan-500/15',
  /** Icon colour for AI icons (Sparkles, brain, etc.). */
  iconColor: 'text-cyan-300',
} as const;

// ---------------------------------------------------------------------------
// Finding categories — engine PR #137's `category` field. Domain scans now
// produce findings in `email_security`, `dns_security`, `secret_leak`,
// `vulnerable_dependency`, `authentication_bypass`, plus expanded
// `info_disclosure` and `subdomain_takeover`. Until this map exists, those
// findings render as raw category strings or "Other".
//
// Unknown categories fall back to the `_default` entry (HelpCircle / neutral).
// ---------------------------------------------------------------------------

export interface CategoryTheme {
  Icon: LucideIcon;
  label: string;
  /** Tailwind classes for the small inline chip on the finding card. */
  pill: string;
  /** Plain colour name for the icon when used standalone. */
  iconColor: string;
}

export const CATEGORY_THEME: Record<string, CategoryTheme> = {
  // Engine surface in domain scans (PRs #19 + #26 + #27 + #28).
  email_security: {
    Icon: Mail,
    label: 'Email security',
    pill: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
    iconColor: 'text-violet-300',
  },
  dns_security: {
    Icon: Network,
    label: 'DNS security',
    pill: 'bg-cyan-500/10 text-cyan-200 ring-cyan-500/30',
    iconColor: 'text-cyan-300',
  },
  subdomain_takeover: {
    Icon: Globe,
    label: 'Subdomain takeover',
    pill: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    iconColor: 'text-rose-300',
  },
  secret_leak: {
    Icon: KeyRound,
    label: 'Leaked secret',
    pill: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
    iconColor: 'text-orange-300',
  },
  vulnerable_dependency: {
    Icon: Package,
    label: 'Vulnerable component',
    pill: 'bg-amber-500/10 text-amber-200 ring-amber-400/30',
    iconColor: 'text-amber-300',
  },
  authentication_bypass: {
    Icon: KeyRound,
    label: 'Auth bypass',
    pill: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    iconColor: 'text-rose-300',
  },
  info_disclosure: {
    Icon: Info,
    label: 'Info disclosure',
    pill: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
    iconColor: 'text-zinc-400',
  },

  // Engine taxonomy for web-app finding types — usage.md §2.3 lists these.
  sqli: {
    Icon: Database,
    label: 'SQL injection',
    pill: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    iconColor: 'text-rose-300',
  },
  xss: {
    Icon: Bug,
    label: 'XSS',
    pill: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
    iconColor: 'text-orange-300',
  },
  cmd_injection: {
    Icon: Bug,
    label: 'Command injection',
    pill: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    iconColor: 'text-rose-300',
  },
  ssrf: {
    Icon: Network,
    label: 'SSRF',
    pill: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
    iconColor: 'text-violet-300',
  },
  auth: {
    Icon: KeyRound,
    label: 'Auth',
    pill: 'bg-orange-500/15 text-orange-200 ring-orange-400/30',
    iconColor: 'text-orange-300',
  },
  authz: {
    Icon: Lock,
    label: 'Authorization',
    pill: 'bg-amber-500/10 text-amber-200 ring-amber-400/30',
    iconColor: 'text-amber-300',
  },
  idor: {
    Icon: Files,
    label: 'IDOR',
    pill: 'bg-amber-500/10 text-amber-200 ring-amber-400/30',
    iconColor: 'text-amber-300',
  },
  crypto: {
    Icon: Key,
    label: 'Crypto',
    pill: 'bg-cyan-500/10 text-cyan-200 ring-cyan-500/30',
    iconColor: 'text-cyan-300',
  },
  csrf: {
    Icon: Repeat,
    label: 'CSRF',
    pill: 'bg-amber-500/10 text-amber-200 ring-amber-400/30',
    iconColor: 'text-amber-300',
  },
  path_traversal: {
    Icon: Server,
    label: 'Path traversal',
    pill: 'bg-rose-500/15 text-rose-200 ring-rose-400/30',
    iconColor: 'text-rose-300',
  },
  misconfig: {
    Icon: Code2,
    label: 'Misconfiguration',
    pill: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
    iconColor: 'text-zinc-400',
  },
  race_condition: {
    Icon: Repeat,
    label: 'Race condition',
    pill: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
    iconColor: 'text-violet-300',
  },
  open_redirect: {
    Icon: Link2,
    label: 'Open redirect',
    pill: 'bg-amber-500/10 text-amber-200 ring-amber-400/30',
    iconColor: 'text-amber-300',
  },
  other: {
    Icon: HelpCircle,
    label: 'Other',
    pill: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    iconColor: 'text-neutral-400',
  },

  _default: {
    Icon: HelpCircle,
    label: 'Other',
    pill: 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40',
    iconColor: 'text-neutral-400',
  },
};

/** Look up a category theme; falls back gracefully on unknown strings. */
export function getCategoryTheme(category: string | null | undefined): CategoryTheme {
  if (!category) return CATEGORY_THEME._default;
  return CATEGORY_THEME[category.toLowerCase()] ?? CATEGORY_THEME._default;
}
