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

// Masthead on the home shell only, and only outside the installed app
// (.forge-launch, globals.css). LCP measured element render delay at 5,320ms
// waiting on the bundle; LCP counts text and images, so a skeleton would not
// have helped. Installed users already get the manifest splash.
const LaunchMasthead = () => (
  <div className="forge-launch">
    <div style={{ padding: "52px 24px 0", maxWidth: 430, margin: "0 auto" }}>
      <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 8 }}>Heatwayve</div>
      {/* Display size: LCP only supersedes when a LARGER element paints, so
          this must be at least as big as the h1 that replaces it. Bing does not
          credit an h1 inside <noscript>, which is where the only one was. */}
      <h1 style={{ fontFamily: "var(--font-bodoni), serif", fontOpticalSizing: "none", fontSize: 45, lineHeight: 1.05, color: "var(--ink)", margin: 0, fontWeight: 400 }}>
        Train with intention
      </h1>
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
