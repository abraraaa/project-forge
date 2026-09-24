// app/profile/main-lifts/page.jsx
// The main-lift editor, branched off /profile so the settings list stays a
// list. Same ssr:false shell and the same no-index reasoning as /profile.

export const metadata = {
  title: "Main lifts",
  description: "Choose the anchor movement for each main-lift slot.",
  robots: { index: false, follow: true },
};

import { MainLiftsShell } from "@/components/client-shells";

export default function MainLiftsPage() {
  return <MainLiftsShell />;
}
