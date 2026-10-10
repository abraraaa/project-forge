// app/trainer/coach/page.jsx — a client's session, run on the trainer's
// device. Same ssr:false shell and no-index reasoning as /trainer.

export const metadata = {
  title: "Session",
  description: "A client's session, run with them.",
  robots: { index: false, follow: false },
};

import { TrainerCoachShell } from "@/components/client-shells";

export default function TrainerCoachPage() {
  return <TrainerCoachShell />;
}
