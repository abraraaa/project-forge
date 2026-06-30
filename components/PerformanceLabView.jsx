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
import { P, H, backgroundSync } from "@/lib/storage";
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

  // router.back() pops the navigation — for the intercepted overlay this
  // closes the overlay and reveals the untouched Home underneath (scroll
  // preserved natively, no remount). Fall back to push("/") only if there's
  // no in-app history to pop (direct deep-link / future shortcut).
  const onBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/");
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
      <PerformanceLab history={history} onBack={onBack} />
    </ErrorBoundary>
  );
}
