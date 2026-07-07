"use client";

// components/PerformanceLabView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shared Performance Lab route view — the data-loading + back-nav wrapper around
// the presentational PerformanceLab component. Used by BOTH:
//   - app/performance/page.jsx          (full-page, direct/deep-link visits)
//   - app/@overlay/(.)performance/...   (intercepted overlay over a still-
//                                         mounted Home, so Home's scroll is
//                                         natively preserved — PR3 stage C)
// Reads the active profile + local history on mount (local is canonical) and
// kicks a backgroundSync so a direct visit still refreshes from blob.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { P, H, Bk, backgroundSync } from "@/lib/storage";
import { withNavTransition } from "@/lib/nav-transitions";
import PerformanceLab from "@/components/PerformanceLab";
import ErrorBoundary from "@/components/ErrorBoundary";

export default function PerformanceLabView() {
  const router = useRouter();
  // Lazy initialisers — localStorage reads are impure in render; the
  // function-form useState arg runs once on mount, sidestepping the purity rule.
  const [profile] = useState(() =>
    typeof window === "undefined" ? null : P.getActive(),
  );
  const [history, setHistory] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? [] : H.get(P.getActive()),
  );
  // Resting = a declared breather is open. Only the DECLARED state surfaces
  // here; an undeclared quiet stretch is already covered by the Home nudge
  // and the VolumeLandscape away-state (showing both would repeat the
  // "lighter stretch is part of training" line on one screen).
  const [resting] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? false : !!Bk.getActive(P.getActive()),
  );

  // router.back() pops the navigation — for the intercepted overlay this
  // closes the overlay and reveals the untouched Home underneath (scroll
  // preserved natively, no remount). Fall back to push("/") only if there's
  // no in-app history to pop (direct deep-link / future shortcut).
  const onBack = useCallback(() => {
    withNavTransition(() => {
      if (typeof window !== "undefined" && window.history.length > 1) router.back();
      else router.push("/");
    }, "nav-back");
  }, [router]);

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
      <PerformanceLab history={history} onBack={onBack} resting={resting} />
    </ErrorBoundary>
  );
}
