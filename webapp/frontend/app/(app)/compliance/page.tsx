// Compliance questionnaire pre-fill page — Tier A #2 ("the killer feature").
//
// For the vibe-coded founder whose prospect just sent a 200-question
// vendor security assessment. They pick a template (SOC 2 SAQ / SIG /
// CAIQ), the page joins TensorShield's compliance_evidence verdicts to
// the question library, and they export the pre-filled answers as
// CSV / JSON to paste into the prospect's spreadsheet.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import QuestionnaireClient from './questionnaire-client';

export const metadata = {
  title: 'Compliance · Questionnaires',
};

interface AvailableTemplate {
  key: string;
  framework: string;
  question_count: number;
}

export default async function CompliancePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // List all questionnaire templates grouped by key. Read-only catalog,
  // RLS-public so this select works for any authenticated user.
  const { data: rows } = await supabase
    .from('compliance_questionnaire_templates')
    .select('key, framework')
    .order('key');

  const grouped = new Map<string, AvailableTemplate>();
  for (const row of (rows ?? []) as Array<{ key: string; framework: string }>) {
    const ex = grouped.get(row.key);
    if (ex) {
      ex.question_count += 1;
    } else {
      grouped.set(row.key, {
        key: row.key,
        framework: row.framework,
        question_count: 1,
      });
    }
  }
  const templates = Array.from(grouped.values());

  return <QuestionnaireClient templates={templates} />;
}
