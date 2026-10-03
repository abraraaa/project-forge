// app/share/page.jsx — a trainer's share link. Shows how to enter the code
// in the app; same ssr:false shell and no-index reasoning as /profile.

export const metadata = {
  title: "Add a trainer",
  description: "Enter a trainer's code in the Heatwayve app.",
  robots: { index: false, follow: false },
};

import { ShareShell } from "@/components/client-shells";

export default function SharePage() {
  return <ShareShell />;
}
