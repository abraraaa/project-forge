"use client";

// components/client-shells.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Client-only mounts for every localStorage-determined route view. Their
// first render is decided by LS (onboarded flag, active profile, history,
// session draft) — data the server can never see — so ANY server-rendered
// branch is wrong for someone: measured 2026-07-06, the SSR pass of /
// always painted ProfileScreen and React #418-regenerated the whole tree
// for every cohort on every cold document load; /performance and /profile
// mismatched the same way.
//
// ssr:false ends the pretence: the server ships the neutral substrate
// (html/body field + grain — brand-correct for everyone) and each view
// renders exactly once, client-side, with LS available. Every lazy
// initializer from the instant-hydration work (#179) keeps working
// unchanged, and there is no server tree to mismatch. Client-side
// navigation is untouched (views always mount with window present on that
// path). Probed before/after: client-back and reload scroll numbers are
// identical; the hydration errors are gone.
//
// The loading shell is deliberately empty: a full-height div so the
// document has height while the chunk loads, over the substrate the root
// layout already paints. No wordmark, no spinner — a beat of warm field
// reads calmer than a flash of the wrong screen ever did.
// ─────────────────────────────────────────────────────────────────────────────

import dynamic from "next/dynamic";

const FieldBeat = () => <div style={{ minHeight: "100vh" }} aria-hidden="true" />;

// The home shell gets a masthead the OTHER shells do not, and only OUTSIDE the
// installed app (.forge-launch, app/globals.css).
//
// Why at all: the LCP breakdown measured TTFB at 0ms and element render delay
// at 5,320ms — every millisecond of it waiting for the bundle to execute before
// anything could paint. A skeleton would not have helped; LCP counts only text
// and images, so a grey block is invisible to it. This is real text, at display
// size, in the server HTML.
//
// Why browser-only: an installed app already showed a splash on launch — the
// manifest carries name, background_color and five icons — so a second brand
// beat inside the page is redundant for exactly the people who see it most.
// They keep the deliberate empty field. Web visitors, who have had no splash
// and are the ones deciding whether to stay, get something to read.
const LaunchMasthead = () => (
  <div className="forge-launch">
    <div style={{ padding: "52px 24px 0", maxWidth: 430, margin: "0 auto" }}>
      <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 8 }}>Heatwayve</div>
      {/* Display size on purpose: LCP only supersedes a candidate when a LARGER
          one paints, so this has to be at least as big as the h1 that replaces
          it or the metric lands on the late one anyway. */}
      <div style={{ fontFamily: "var(--font-bodoni), serif", fontOpticalSizing: "none", fontSize: 45, lineHeight: 1.05, color: "var(--ink)" }}>
        Train with intention
      </div>
      <div style={{ fontSize: 15, color: "var(--ink-2)", marginTop: 12, lineHeight: 1.45, maxWidth: "32ch" }}>
        Evidence-based strength training that adjusts to what you actually
        lifted — and keeps every muscle&rsquo;s weekly volume honest.
      </div>
    </div>
  </div>
);

export const ForgeAppShell = dynamic(() => import("@/components/ForgeApp"), {
  ssr: false,
  loading: LaunchMasthead,
});

export const PerformanceLabShell = dynamic(() => import("@/components/PerformanceLabView"), {
  ssr: false,
  loading: FieldBeat,
});

export const ProfileShell = dynamic(() => import("@/components/ProfileView"), {
  ssr: false,
  loading: FieldBeat,
});

export const SessionShell = dynamic(() => import("@/components/SessionHost"), {
  ssr: false,
  loading: FieldBeat,
});
