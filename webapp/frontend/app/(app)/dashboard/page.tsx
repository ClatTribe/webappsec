import { redirect } from 'next/navigation';

// /dashboard is the legacy primary landing page. PR B replaced it
// with /home (adaptive empty / populated state). Keep the URL alive
// as a redirect so:
//   - existing bookmarks still resolve
//   - email links from older notifications still work
//   - the brand-lockup link in the sidebar (now → /home) doesn't
//     leave a 404 surface anywhere
//
// The original dashboard rendering (335 lines of static charts +
// snapshot cards) is replaced with this two-line redirect — the new
// /home is the single source of truth for "what should I look at
// today?".

export default function LegacyDashboardRedirect() {
  redirect('/home');
}
