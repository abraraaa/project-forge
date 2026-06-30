"use client";

// app/performance/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Performance Lab as a real route (PR3 stage 3a — first leaf migrated from the
// setScreen SPA to the Next router). PerformanceLab was already a standalone
// component (components/PerformanceLab.jsx) with a minimal {history, onBack}
// interface, so route-ifying it needs no monolith extraction — pure
// proof-of-pattern for the real-routes migration.
//
// Data: reads the active profile + local history on mount (local is canonical;
// the main app keeps it synced). Kicks a backgroundSync on mount so a deep-
// link / direct nav still refreshes from blob — same behaviour the old
// handleOpenPerformance had. Reached via router.push("/performance") (soft
// client navigation — no document reload, no shimmer).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { P, H, backgroundSync } from "@/lib/storage";
import PerformanceLab from "@/components/PerformanceLab";
import ErrorBoundary from "@/components/ErrorBoundary";

export default function PerformancePage() {
  const router = useRouter();
  // Lazy initialisers — localStorage reads are impure in render; the
  // function-form useState arg runs once on mount, sidestepping the purity rule.
  const [profile] = useState(() =>
    typeof window === "undefined" ? null : P.getActive(),
  );
  const [history, setHistory] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? [] : H.get(P.getActive()),
  );

  // Prefer a real back navigation so Next restores the Home scroll position
  // natively (applied pre-paint, coordinated with the navigation commit — no
  // jump). router.push("/") would be a FORWARD nav, which Next scrolls to top
  // by design. Fall back to push only if there's no in-app history to pop
  // (e.g. a future deep-link / shortcut that lands straight on /performance).
  const onBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/");
  }, [router]);

  // Refresh from blob on mount, then re-read local history if the sync landed
  // newer data. Mirrors the old handleOpenPerformance background refresh.
  useEffect(() => {
    if (!profile) {
      router.replace("/"); // no active profile — bounce to the app shell
      return;
    }
    backgroundSync(profile, {
      onUpdate: () => setHistory(H.get(profile)),
    });
  }, [profile, router]);

  if (!profile) return null;

  return (
    <ErrorBoundary>
      <PerformanceLab history={history} onBack={onBack} />
    </ErrorBoundary>
  );
}
