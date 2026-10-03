// app/trainer/page.jsx — the trainer dashboard. Same ssr:false shell and
// no-index reasoning as /profile.

export const metadata = {
  title: "Trainer",
  description: "Training your clients share with you.",
  robots: { index: false, follow: false },
};

import { TrainerShell } from "@/components/client-shells";

export default function TrainerPage() {
  return <TrainerShell />;
}
