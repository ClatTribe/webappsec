import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Brain, ChevronRight, BookOpen } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import CustomRulesClient from './custom-rules-client';

export const metadata = {
  title: 'Settings · Custom rules',
};

interface CustomRuleRow {
  id: string;
  name: string;
  description: string | null;
  language: string;
  severity: string;
  cwe: string | null;
  enabled: boolean;
  rule_hash: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

// Custom rule library — per-org Semgrep rule authoring + storage.
//
// /settings/custom-rules — list + author + toggle. Server-renders
// the active rules; the client handles create / edit / archive.

export default async function CustomRulesPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rules } = await supabase
    .from('custom_rules')
    .select(
      'id, name, description, language, severity, cwe, enabled, rule_hash, created_at, updated_at, last_used_at',
    )
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-4xl space-y-6">
      <nav className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <Link href="/settings" className="transition-colors hover:text-neutral-300">
          Settings
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-neutral-300">Custom rules</span>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-violet-300" strokeWidth={2.25} />
          <h1 className="text-3xl font-semibold tracking-tight">Custom rule library</h1>
        </div>
        <p className="max-w-2xl text-sm text-neutral-400">
          Author per-org Semgrep rules for patterns specific to your stack —
          framework-specific misuse, internal naming conventions, deprecated
          APIs you want surfaced as findings. The worker dumps enabled rules
          into the scan workdir and forwards{' '}
          <code className="rounded bg-neutral-800/80 px-1 py-0.5 text-xs">STRIX_CUSTOM_RULES_DIR</code>{' '}
          so the engine consumes them alongside its built-in rule pack.
        </p>
        <a
          href="https://semgrep.dev/docs/writing-rules/rule-syntax"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11.5px] text-cyan-300 underline-offset-2 hover:underline"
        >
          <BookOpen className="h-3 w-3" strokeWidth={2.5} />
          Semgrep rule syntax reference
        </a>
      </header>

      <CustomRulesClient initialRules={(rules ?? []) as CustomRuleRow[]} />
    </div>
  );
}
