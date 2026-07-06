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
};

import { ProfileShell } from "@/components/client-shells";

export default function ProfilePage() {
  return <ProfileShell />;
}
