import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Tier II #9 — onboarding state mutation.
//
//   POST /api/onboarding/state   body: { action: 'start' | 'skip' | 'complete' }
//
// Transitions:
//   pending      → start    → in_progress      (user clicked "Detect my stack")
//   *            → skip     → dismissed        (user clicked the × or "I'll do it myself")
//   in_progress  → complete → completed        (user finished the wizard)
//
// We deliberately allow `skip` from any state — a user can dismiss the
// dialog mid-wizard. `start` is forgiving too: re-clicking "Detect my
// stack" while already in_progress is a no-op rather than an error.
//
// The route reads the user from the auth cookie and updates the
// matching `profiles` row directly. RLS lets a user update their own
// profile row (id = auth.uid()).

type Action = 'start' | 'skip' | 'complete';

export async function POST(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action as Action;
  if (!action || !['start', 'skip', 'complete'].includes(action)) {
    return NextResponse.json(
      { error: 'action must be one of: start, skip, complete' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {};

  if (action === 'start') {
    update.onboarding_state = 'in_progress';
  } else if (action === 'skip') {
    update.onboarding_state = 'dismissed';
    update.onboarding_dismissed_at = now;
  } else if (action === 'complete') {
    update.onboarding_state = 'completed';
    update.onboarding_completed_at = now;
  }

  const { error } = await supabase
    .from('profiles')
    .update(update as never)
    .eq('id', user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, state: update.onboarding_state });
}
