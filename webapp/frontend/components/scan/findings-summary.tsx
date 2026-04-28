'use client';

import { useMemo, useState } from 'react';
import {
  Database,
  Globe,
  Terminal,
  ServerCog,
  KeyRound,
  Lock,
  EyeOff,
  Repeat,
  FolderTree,
  Settings2,
  Clock,
  Forward,
  ShieldQuestion,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Finding, Severity, ScanStatus } from '@/lib/supabase/types';
import FindingCard from '@/components/finding/finding-card';

// --- Categorisation ---------------------------------------------------------
//
// The scan UI today shows raw findings. For a non-tech reader (or even a busy
// dev), seeing 8 findings spread across 4 different attack classes is harder
// to act on than seeing "3 SQL-injection issues / 2 SSRF / 3 misconfigurations"
// with a one-line plain-English description of each class.
//
// Strix doesn't tag findings with a semantic category, so we infer one. CWE
// is the strongest signal when present; otherwise we fall back to keyword
// matching on the title (e.g., "SSRF" / "SQL injection" / "RCE" are
// near-universal), and last-resort to the catch-all "Other".

type CategoryKey =
  | 'sqli'
  | 'xss'
  | 'cmd'
  | 'ssrf'
  | 'auth'
  | 'authz'
  | 'idor'
  | 'crypto'
  | 'leak'
  | 'csrf'
  | 'pathtrav'
  | 'config'
  | 'race'
  | 'redirect'
  | 'other';

interface CategoryDef {
  key: CategoryKey;
  name: string;
  description: string;
  icon: LucideIcon;
  cwes: string[];
  keywords: string[];
}

const CATEGORIES: CategoryDef[] = [
  {
    key: 'sqli',
    name: 'SQL Injection',
    description:
      'An attacker can read or modify your database by injecting SQL through input fields.',
    icon: Database,
    cwes: ['CWE-89'],
    keywords: ['sql injection', 'sqli'],
  },
  {
    key: 'xss',
    name: 'Cross-Site Scripting (XSS)',
    description:
      "An attacker can run JavaScript in your users' browsers via unsafe rendering of input.",
    icon: Globe,
    cwes: ['CWE-79', 'CWE-80', 'CWE-83'],
    keywords: ['xss', 'cross-site scripting', 'reflected scripting'],
  },
  {
    key: 'cmd',
    name: 'Code or Command Injection',
    description: 'An attacker can execute commands or arbitrary code on your server.',
    icon: Terminal,
    cwes: ['CWE-77', 'CWE-78', 'CWE-94', 'CWE-95'],
    keywords: ['rce', 'remote code execution', 'command injection', 'code injection'],
  },
  {
    key: 'ssrf',
    name: 'Server-Side Request Forgery (SSRF)',
    description:
      "An attacker can trick your server into making requests to systems they shouldn't reach (cloud metadata, internal services, localhost).",
    icon: ServerCog,
    cwes: ['CWE-918'],
    keywords: ['ssrf', 'server-side request forgery'],
  },
  {
    key: 'auth',
    name: 'Authentication',
    description:
      'How users prove who they are. Issues here let attackers log in as someone else, or skip login entirely.',
    icon: KeyRound,
    cwes: ['CWE-287', 'CWE-294', 'CWE-303', 'CWE-306', 'CWE-307'],
    keywords: ['authentication', 'login bypass', 'auth bypass', 'brute force', 'session fixation'],
  },
  {
    key: 'authz',
    name: 'Authorisation & Access Control',
    description:
      "Who's allowed to do what. Issues here let users access data or features they shouldn't.",
    icon: Lock,
    cwes: ['CWE-269', 'CWE-285', 'CWE-862', 'CWE-863'],
    keywords: [
      'authorization',
      'authorisation',
      'access control',
      'broken function-level',
      'bfla',
      'rls',
    ],
  },
  {
    key: 'idor',
    name: 'Insecure Direct Object Reference (IDOR)',
    description: "A user can read or modify another user's data by changing IDs in URLs.",
    icon: Lock,
    cwes: ['CWE-639'],
    keywords: ['idor', 'direct object reference'],
  },
  {
    key: 'crypto',
    name: 'Secrets & Cryptography',
    description: 'Hardcoded credentials, weak hashes, or insecure key handling.',
    icon: KeyRound,
    cwes: ['CWE-321', 'CWE-326', 'CWE-327', 'CWE-330', 'CWE-798'],
    keywords: ['hardcoded', 'credential', 'secret', 'weak crypto', 'weak hash', 'plaintext'],
  },
  {
    key: 'leak',
    name: 'Information Disclosure',
    description: "Sensitive data is exposed to people who shouldn't see it.",
    icon: EyeOff,
    cwes: ['CWE-200', 'CWE-201', 'CWE-209', 'CWE-532'],
    keywords: ['information disclosure', 'data exposure', 'sensitive data', 'leak'],
  },
  {
    key: 'csrf',
    name: 'Cross-Site Request Forgery (CSRF)',
    description: "A logged-in user can be tricked into performing actions they didn't intend.",
    icon: Repeat,
    cwes: ['CWE-352'],
    keywords: ['csrf'],
  },
  {
    key: 'pathtrav',
    name: 'Path Traversal',
    description: 'An attacker can read or write files outside the intended directory.',
    icon: FolderTree,
    cwes: ['CWE-22', 'CWE-23'],
    keywords: ['path traversal', 'directory traversal'],
  },
  {
    key: 'config',
    name: 'Misconfiguration',
    description: 'A security setting is wrong, missing, or disabled by default.',
    icon: Settings2,
    cwes: ['CWE-16', 'CWE-732', 'CWE-1188'],
    keywords: [
      'misconfiguration',
      'insecure default',
      'permissions too permissive',
      'configuration',
      'audit gap',
    ],
  },
  {
    key: 'race',
    name: 'Race Condition',
    description: "Two simultaneous actions can produce a state the application didn't expect.",
    icon: Clock,
    cwes: ['CWE-362', 'CWE-367'],
    keywords: ['race condition', 'toctou'],
  },
  {
    key: 'redirect',
    name: 'Open Redirect',
    description: 'Your app can be used to redirect users to attacker-controlled URLs.',
    icon: Forward,
    cwes: ['CWE-601'],
    keywords: ['open redirect'],
  },
  {
    key: 'other',
    name: 'Other',
    description: "Issues that don't map cleanly to a standard category.",
    icon: ShieldQuestion,
    cwes: [],
    keywords: [],
  },
];

const CATEGORY_BY_KEY: Record<CategoryKey, CategoryDef> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
) as Record<CategoryKey, CategoryDef>;

// CWE may live on the column (newer scans) or only inside description_md
// (older scans where the parser didn't promote it). Try both.
function extractCwe(f: Finding): string | null {
  if (f.cwe) return f.cwe.toUpperCase().trim();
  const m = (f.description_md ?? '').match(/\*\*CWE:\*\*\s*(CWE-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

function categoriseFinding(f: Finding): CategoryKey {
  const cwe = extractCwe(f);
  if (cwe) {
    for (const cat of CATEGORIES) {
      if (cat.cwes.includes(cwe)) return cat.key;
    }
  }
  const title = f.title.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some((kw) => title.includes(kw))) return cat.key;
  }
  return 'other';
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function maxSeverityIndex(findings: Finding[]): number {
  let best = SEVERITY_ORDER.length;
  for (const f of findings) {
    const i = SEVERITY_ORDER.indexOf(f.severity);
    if (i >= 0 && i < best) best = i;
  }
  return best;
}

const SEVERITY_PILL: Record<Severity, string> = {
  critical: 'bg-red-600/15 text-red-200 ring-red-500/40',
  high: 'bg-orange-500/15 text-orange-200 ring-orange-400/40',
  medium: 'bg-yellow-500/15 text-yellow-200 ring-yellow-400/40',
  low: 'bg-lime-500/15 text-lime-200 ring-lime-400/40',
  info: 'bg-neutral-700/40 text-neutral-200 ring-neutral-600/40',
};

interface Bucket {
  cat: CategoryDef;
  findings: Finding[];
}

export default function FindingsSummary({
  findings,
  status,
}: {
  findings: Finding[];
  status: ScanStatus;
}) {
  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<CategoryKey, Finding[]>();
    for (const f of findings) {
      const key = categoriseFinding(f);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return [...map.entries()]
      .map(([key, fs]) => ({ cat: CATEGORY_BY_KEY[key], findings: fs }))
      .sort(
        (a, b) =>
          maxSeverityIndex(a.findings) - maxSeverityIndex(b.findings) ||
          b.findings.length - a.findings.length ||
          a.cat.name.localeCompare(b.cat.name),
      );
  }, [findings]);

  const [expanded, setExpanded] = useState<Set<CategoryKey>>(() => {
    // Auto-expand the highest-severity category if there's exactly one.
    return new Set();
  });

  const toggle = (key: CategoryKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (findings.length === 0) {
    // Don't render anything for empty findings — the "All findings" section
    // below already shows the right empty state. Avoids a duplicate placeholder.
    if (status === 'completed') {
      return (
        <section className="rounded-2xl border border-emerald-800/40 bg-emerald-900/10 p-5 ring-1 ring-emerald-500/20">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-300" strokeWidth={2} />
            <div>
              <h2 className="text-sm font-semibold text-emerald-100">
                Scan complete — no issues to report.
              </h2>
              <p className="mt-1 text-sm text-emerald-200/80">
                The agents finished without producing any vulnerability reports for this target.
                If you've recently shipped a fix, that's the expected outcome.
              </p>
            </div>
          </div>
        </section>
      );
    }
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-300">
          What we found
        </h2>
        <span className="text-xs text-neutral-500">
          {findings.length} issue{findings.length === 1 ? '' : 's'} across {buckets.length}{' '}
          categor{buckets.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      <div className="space-y-2.5">
        {buckets.map(({ cat, findings: fs }) => {
          const Icon = cat.icon;
          const isOpen = expanded.has(cat.key);
          const sevCounts = SEVERITY_ORDER.map((s) => ({
            s,
            n: fs.filter((f) => f.severity === s).length,
          })).filter((x) => x.n > 0);
          return (
            <div
              key={cat.key}
              className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/30 transition-colors hover:border-neutral-700"
            >
              <button
                type="button"
                onClick={() => toggle(cat.key)}
                className="flex w-full items-start gap-3 p-4 text-left"
              >
                <ChevronRight
                  className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-neutral-500 transition-transform ${
                    isOpen ? 'rotate-90 text-neutral-300' : ''
                  }`}
                  strokeWidth={2.5}
                />
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-neutral-300" strokeWidth={2} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-100">{cat.name}</span>
                    <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-300">
                      {fs.length}
                    </span>
                    {sevCounts.map(({ s, n }) => (
                      <span
                        key={s}
                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${SEVERITY_PILL[s]}`}
                      >
                        {n} {s}
                      </span>
                    ))}
                  </div>
                  <p className="text-[13px] leading-relaxed text-neutral-300">
                    {cat.description}
                  </p>
                </div>
              </button>
              {isOpen && (
                <div className="space-y-3 border-t border-neutral-800/60 bg-neutral-950/40 px-4 py-4">
                  {fs.map((f) => (
                    <FindingCard key={f.id} finding={f} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
