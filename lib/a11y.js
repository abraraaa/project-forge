// @ts-check
// lib/a11y.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared accessibility hooks. Extracted from ForgeApp.jsx so other components
// (GlossarySheet, future shared modals) can reuse without duplicating.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from "react";

// Semantic haptic vocabulary. iOS Safari's navigator.vibrate is a no-op
// (returns false silently) — these calls are free on iOS and meaningful
// on Android PWAs. Three patterns matched to action weight:
//   tap     — light confirmation: drum snap, toggle, sheet open
//   commit  — successful submission: log a set, mark a day, confirm RPE
//   alert   — rest timer expired (longer existing pulse)
// Wrapped defensively so undefined navigator / missing vibrate / browser
// rejection never throws into a tap handler.
export const haptic = {
  tap:    () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10); } catch { /* noop */ } },
  commit: () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([8, 30, 20]); } catch { /* noop */ } },
  alert:  () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(200); } catch { /* noop */ } },
};

// useModalA11y — accessibility wiring for a bottom-sheet / dialog component.
//
// Behaviour:
//   - Saves the focused element before mount; restores focus to it on unmount
//     so closing the sheet returns you to where you were (no focus loss).
//   - Auto-focuses the dialog container on mount so screen-readers announce
//     it and Tab starts inside.
//   - Escape key closes via onClose.
//   - Tab / Shift+Tab focus trap keeps focus inside the modal so screen-reader
//     and keyboard users can't tab into the page underneath.
//
// Usage:
//   const { containerRef, onKeyDown } = useModalA11y(onClose);
//   return <div onKeyDown={onKeyDown} onClick={onClose}>
//     <div ref={containerRef} role="dialog" aria-modal="true"
//          aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}>
//       <h2 id={titleId}>…</h2>
//     </div>
//   </div>
export function useModalA11y(onClose) {
  const containerRef = useRef(null);
  const prevFocusRef = useRef(null);

  useEffect(() => {
    prevFocusRef.current = typeof document !== "undefined" ? document.activeElement : null;
    const id = setTimeout(() => {
      if (containerRef.current && typeof containerRef.current.focus === "function") {
        try { containerRef.current.focus({ preventScroll: true }); } catch { /* noop */ }
      }
    }, 0);
    return () => {
      clearTimeout(id);
      const prev = prevFocusRef.current;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        try { prev.focus({ preventScroll: true }); } catch { /* noop */ }
      }
    };
  }, []);

  const onKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      if (onClose) {
        e.stopPropagation();
        onClose();
      }
      return;
    }
    if (e.key === "Tab" && containerRef.current) {
      const focusables = containerRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === containerRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose]);

  return { containerRef, onKeyDown };
}
