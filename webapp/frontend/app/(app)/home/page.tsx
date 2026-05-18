import { redirect } from 'next/navigation';

// Home — placeholder for PR A.
//
// PR B replaces this with an adaptive page that surfaces today's inbox
// + posture for populated workspaces and a connect-your-first-system
// flow for empty ones. Until then, the old Dashboard still does the
// right thing, so route through.

export default function HomePage() {
  redirect('/dashboard');
}
