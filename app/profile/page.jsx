// app/profile/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Profile switch/settings as a real route (PR3 3d-route). The sign-in GATE is
// not this page — with no active profile there's nowhere to navigate from, so
// the gate stays rendered by ForgeApp at / (this page bounces there).
// Deliberately full-page (no @overlay interception): profile activation must
// remount the app shell. See components/ProfileView.jsx.
// ─────────────────────────────────────────────────────────────────────────────

export const metadata = {
  title: "Profile",
  description:
    "Switch profiles, set bodyweight, and choose your training focus — Forged, Strong, or Sculpt.",
  // ssr:false shell — a crawler receives an empty document (~70 chars of
  // body, measured 2026-08-17). Indexing it would publish a blank result and
  // spend crawl budget on an app surface, so we ask for neither. `follow`
  // stays on: nothing is hidden, it simply is not a page to rank.
  // Same reasoning that already excludes /session. The readable version of
  // this story lives on /volume-landmarks and /anatomy.
  robots: { index: false, follow: true },
};

import { ProfileShell } from "@/components/client-shells";

export default function ProfilePage() {
  return <ProfileShell />;
}
