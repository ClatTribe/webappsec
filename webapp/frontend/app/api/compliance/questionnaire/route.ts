// Fetch a pre-filled compliance questionnaire for the caller's org.
//
// Built for the vibe-coded founder's prospect workflow:
//   - Prospect sends a vendor security assessment (SIG / CAIQ / SOC 2 SAQ).
//   - Founder opens /compliance, picks the questionnaire, gets pre-filled
//     answers from their actual compliance_evidence verdicts.
//   - Exports CSV/JSON to paste into the prospect's spreadsheet.
//
// Returns:
//   {
//     key, template_meta,
//     answers: [
//       { pos, section, question_id, question, note, control_ids,
//         answer_status: 'pass'|'fail'|'warn'|'partial'|'untested',
//         evidence: [{control_id, verdict, summary, observed_at}, …] },
//       …
//     ]
//   }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const Query = z.object({
  key: z.string().min(1).max(64),
});

export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const parsed = Query.safeParse({ key: url.searchParams.get('key') ?? '' });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid key' }, { status: 400 });
  }

  // Resolve active org from the user's JWT. The RPC trusts the caller
  // and reads compliance_evidence under their auth context, so RLS is
  // the second line of defence.
  const sessionResp = await supabase.auth.getSession();
  const tok = sessionResp.data.session?.access_token;
  let orgId: string | null = null;
  if (tok) {
    try {
      const claims = JSON.parse(
        Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'),
      ) as { org_id?: string };
      orgId = claims.org_id ?? null;
    } catch {
      // claims unparseable — treat as no org
    }
  }
  if (!orgId) {
    return NextResponse.json({ error: 'no active org' }, { status: 403 });
  }

  const { data: answers, error: answersErr } = await supabase.rpc(
    'org_questionnaire_response',
    {
      p_org_id: orgId,
      p_key: parsed.data.key,
    } as never,
  );

  if (answersErr) {
    return NextResponse.json(
      { error: `rpc failed: ${answersErr.message}` },
      { status: 500 },
    );
  }

  // List available questionnaires (template metadata) so the frontend
  // can render the picker without a second round-trip.
  const { data: templates } = await supabase
    .from('compliance_questionnaire_templates')
    .select('key, framework')
    .eq('key', parsed.data.key)
    .limit(1);
  const meta = (templates ?? [])[0] ?? null;

  return NextResponse.json({
    key: parsed.data.key,
    framework: (meta as { framework?: string } | null)?.framework ?? null,
    answers: answers ?? [],
  });
}
