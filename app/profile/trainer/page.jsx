// app/profile/trainer/page.jsx — your trainer: what is shared, every look,
// stop sharing. Same ssr:false shell and no-index reasoning as /profile.

export const metadata = {
  title: "Your trainer",
  description: "What your trainer sees, and how to stop sharing.",
  robots: { index: false, follow: false },
};

import { TrainerShareShell } from "@/components/client-shells";

export default function TrainerSharePage() {
  return <TrainerShareShell />;
}
