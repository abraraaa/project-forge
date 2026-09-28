// app/performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Performance Lab as its own route. Every visit lands here, from Home or
// direct: there is no intercepting overlay route, so Home unmounts on the way
// in and remounts on the way back. Renders PerformanceLabView.
// ─────────────────────────────────────────────────────────────────────────────

export const metadata = {
  title: "Performance Lab",
  description:
    "Per-muscle volume against MEV/MAV/MRV, 8-week sparklines, a consistency grid, and 1RM trends. See exactly where your training is working.",
  // ssr:false shell — a crawler receives an empty document (~70 chars of
  // body, measured 2026-08-17). Indexing it would publish a blank result and
  // spend crawl budget on an app surface, so we ask for neither. `follow`
  // stays on: nothing is hidden, it simply is not a page to rank.
  // Same reasoning that already excludes /session. The readable version of
  // this story lives on /volume-landmarks and /anatomy.
  robots: { index: false, follow: true },
};

import { PerformanceLabShell } from "@/components/client-shells";

export default function PerformancePage() {
  return <PerformanceLabShell />;
}
