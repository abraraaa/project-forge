// app/session/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The live strength session as a real route (PR3 3e-route). Entry arrives
// via a one-shot SessionIntent stashed by the home shell (begin / resume);
// with neither an intent nor a live draft the page bounces to /. Deliberately
// full-page (no @overlay interception): finishing a session must remount the
// home shell so it re-derives streak/week/history projections from LS.
// ─────────────────────────────────────────────────────────────────────────────

import SessionHost from "@/components/SessionHost";

export default function SessionPage() {
  return <SessionHost />;
}
