// app/profile/coach/page.jsx — AI coaching. Same ssr:false shell and no-index
// reasoning as /profile.

export const metadata = {
  title: "AI coaching",
  description: "Talk your training through with the AI of your choice.",
  robots: { index: false, follow: true },
};

import { CoachShell } from "@/components/client-shells";

export default function CoachPage() {
  return <CoachShell />;
}
