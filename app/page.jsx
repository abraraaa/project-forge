// The home page is the app shell. ForgeApp mounts client-only — its first
// render is localStorage-determined, which no server render can match (see
// components/client-shells.jsx for the measured history).
//
// Which left the served HTML with a <title> and nothing else: measured
// 2026-08-17, the crawlable body of "/" was one CSS rule. Google renders JS
// and sees the real page; crawlers that do not — Bing among them — saw an
// empty document, which is why the repo's GitHub page outranked the site for
// its own name.
//
// The <noscript> below is the designed mechanism for exactly this, not a
// workaround: content for agents that do not run scripts. It costs nothing at
// runtime, cannot flash (browsers with JS never render it), and leaves the
// ssr:false decision untouched.
//
// It carries no heading and no pitch: the launch masthead in ForgeAppShell's
// loading state is plain HTML too, so a non-JS reader already has both, and a
// second copy would mean two h1s on one document. What is left is the part
// only this block does — the links onward to the three server-rendered tiers.
import Link from "next/link";
import { ForgeAppShell } from "@/components/client-shells";

export default function Page() {
  return (
    <>
      <noscript>
        <div style={{ padding: "40px 24px", maxWidth: 640, margin: "0 auto" }}>
          <p>
            The app itself needs JavaScript &mdash; a three-day A/B/C rotation
            that progresses from how hard your sets actually felt, holding every
            muscle&rsquo;s weekly volume against the MEV/MAV/MRV landmarks.
            These pages do not:
          </p>
          <ul>
            <li>
              <Link href="/library">The exercise library</Link> — every movement, with
              the weighted per-muscle contributions the volume audit computes
              with, its tempo prescription and approved alternatives.
            </li>
            <li>
              <Link href="/anatomy">Explore your anatomy</Link> — one page per muscle,
              ranking every movement by the share of a set it genuinely credits.
            </li>
            <li>
              <Link href="/volume-landmarks">Volume landmarks</Link> — what MEV, MAV
              and MRV mean, and the per-muscle weekly set targets behind them.
            </li>
          </ul>
        </div>
      </noscript>
      <ForgeAppShell />
    </>
  );
}
