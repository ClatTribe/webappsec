import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Wrench,
  Plug,
  KeyRound,
  Layers,
  Wand2,
  FileLock,
  ShieldCheck,
  Users,
  Building,
  CreditCard,
  Bell,
  Brain,
  Database,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Setup',
};

interface SetupLink {
  href: string;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  badge?: string;
}

// Setup index — task-oriented, replaces the monolithic /settings page
// as the primary configuration entry point.
//
// Five groups, ordered by frequency (edited-often at top, set-once
// at bottom). Each card carries the verb the user thinks in, not the
// entity name. URLs stay the same — this is purely an entry-point
// reorganisation; the underlying sub-pages don't move.

const GROUPS: Array<{
  title: string;
  blurb: string;
  Icon: LucideIcon;
  items: SetupLink[];
}> = [
  {
    title: 'Connect & ingest',
    blurb: 'Wire TensorShield into the systems it watches.',
    Icon: Plug,
    items: [
      {
        href: '/integrations',
        label: 'Integrations',
        blurb: 'GitHub, AWS, GCP, Azure, K8s, Okta, apex domains.',
        Icon: Plug,
      },
      {
        href: '/settings/api-keys',
        label: 'API keys',
        blurb: 'Tokens for CI / CMDB sync scripts and the Cursor / Claude integration.',
        Icon: KeyRound,
      },
    ],
  },
  {
    title: 'Tell us about your stack',
    blurb: 'Shape what we scan and how.',
    Icon: Database,
    items: [
      {
        href: '/settings/target-templates',
        label: 'Asset templates',
        blurb:
          'Shared scan config (cadence, exclude paths, auth method) that many assets can inherit.',
        Icon: Layers,
      },
      {
        href: '/settings/custom-rules',
        label: 'Custom rules',
        blurb: 'Your own rules for things specific to your stack — framework misuse, internal naming, deprecated APIs.',
        Icon: Wand2,
      },
    ],
  },
  {
    title: 'Compliance basics',
    blurb: 'What auditors will check.',
    Icon: FileLock,
    items: [
      {
        href: '/compliance/collectors',
        label: 'Automatic compliance checks',
        blurb:
          'Continuously check GitHub / AWS / GCP / Okta for the things auditors ask about — two-factor auth, key rotation, who has admin.',
        Icon: ShieldCheck,
      },
      {
        href: '/settings',
        label: 'Auditor portal links',
        blurb: 'Time-bounded read-only URLs you can share with auditors.',
        Icon: FileLock,
        badge: 'in Settings',
      },
    ],
  },
  {
    title: 'People & access',
    blurb: 'Who can see what.',
    Icon: Users,
    items: [
      {
        href: '/team',
        label: 'Team members',
        blurb: 'Invite teammates; assign org-level roles.',
        Icon: Users,
      },
      {
        href: '/settings/teams',
        label: 'Workspaces',
        blurb:
          'Per-team sub-groupings — scope assets to a team for routing and visibility.',
        Icon: Building,
      },
    ],
  },
  {
    title: 'Account',
    blurb: 'Set-once configuration.',
    Icon: Wrench,
    items: [
      {
        href: '/settings',
        label: 'Organization & profile',
        blurb: 'Name, slug, public Trust Page settings.',
        Icon: Building,
      },
      {
        href: '/settings',
        label: 'Billing',
        blurb: 'Plan, usage, invoice history.',
        Icon: CreditCard,
        badge: 'in Settings',
      },
      {
        href: '/settings',
        label: 'Notifications',
        blurb: 'Slack bridge, email digests, finding alerts.',
        Icon: Bell,
        badge: 'in Settings',
      },
      {
        href: '/settings',
        label: 'LLM provider',
        blurb: 'Org-level Anthropic / Gemini / OpenAI key (optional).',
        Icon: Brain,
        badge: 'in Settings',
      },
    ],
  },
];

export default async function SetupPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="max-w-5xl space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-cyan-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Setup</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Everything you wire up once. Connect systems, tell us about your
          stack, set who can see what. Daily-use surfaces (assets, findings,
          compliance) live in the main nav.
        </p>
      </header>

      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <g.Icon className="h-4 w-4 text-neutral-500" strokeWidth={2.25} />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
                {g.title}
              </h2>
              <span className="text-[11px] text-neutral-500">— {g.blurb}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {g.items.map((item) => (
                <Link
                  key={`${g.title}-${item.href}-${item.label}`}
                  href={item.href}
                  className="group flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4 transition-all hover:-translate-y-0.5 hover:border-neutral-700 hover:bg-neutral-900/50"
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
                    <item.Icon className="h-4 w-4" strokeWidth={2.25} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-100">
                        {item.label}
                      </span>
                      {item.badge && (
                        <span className="rounded bg-neutral-800/70 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-neutral-400">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-400">
                      {item.blurb}
                    </p>
                  </div>
                  <ChevronRight
                    className="h-3.5 w-3.5 flex-shrink-0 text-neutral-600 transition-colors group-hover:text-cyan-300"
                    strokeWidth={2.25}
                  />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
