// The home page is the app shell. ForgeApp mounts client-only — its first
// render is localStorage-determined, which no server render can match (see
// components/client-shells.jsx for the measured history).
import { ForgeAppShell } from "@/components/client-shells";

export default function Page() {
  return <ForgeAppShell />;
}
