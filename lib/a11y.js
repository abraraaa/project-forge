// @ts-check
// lib/a11y.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared accessibility hooks. Extracted from ForgeApp.jsx so other components
// (GlossarySheet, future shared modals) can reuse without duplicating.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

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

// useSheetDrag — drag-to-dismiss for a bottom sheet, with a velocity-aware
// dismiss and a spring settle-back. Additive to the existing tap-outside /
// Escape / button dismissal (all still work). Drag is gated to a GRAB ZONE
// (the handle + header) via the returned `grabProps`, so sheet buttons and
// chips never fight a tap. Down-only; a flick past a velocity floor OR a
// drag past the distance threshold dismisses, otherwise it eases back.
//
// Usage:
//   const { grabProps, sheetStyle } = useSheetDrag(onClose);
//   <div style={{ ...sheetStyle, ...existingSheetStyle }}>
//     <div {...grabProps}><Handle/><Title/></div>
//     …content…
//   </div>
//
// Returns dragY too (0..n) for callers that want to fade a scrim with drag.
export function useSheetDrag(onClose, { threshold = 88, velocity = 0.5 } = {}) {
  // phase: "rest" (no transform — sheet paints natively so its background
  // extends SEAMLESSLY into the chin; a transform would composite it into
  // its own layer and re-expose the safe-area band) → "drag" (tracks the
  // finger, no transition) → "settle" (eases back to 0) → "leave" (flies off).
  const [dragY, setDragY] = useState(0);
  const [phase, setPhase] = useState("rest");
  const st = useRef(null);
  /** @type {{ current: { raf?: number, rest?: ReturnType<typeof setTimeout> } }} */
  const timers = useRef({});

  const reduced = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  useEffect(() => () => {
    if (timers.current.raf) cancelAnimationFrame(timers.current.raf);
    if (timers.current.rest) clearTimeout(timers.current.rest);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (timers.current.raf) cancelAnimationFrame(timers.current.raf);
    if (timers.current.rest) clearTimeout(timers.current.rest);
    st.current = { y0: e.clientY, y: e.clientY, t: e.timeStamp, vy: 0 };
    setPhase("drag");
    setDragY(0);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);

  const onPointerMove = useCallback((e) => {
    const s = st.current;
    if (!s) return;
    const dt = Math.max(1, e.timeStamp - s.t);
    s.vy = (e.clientY - s.y) / dt; // px/ms, signed
    s.y = e.clientY;
    s.t = e.timeStamp;
    setDragY(Math.max(0, e.clientY - s.y0)); // down only
  }, []);

  // pointerup AND pointercancel both land here — iOS fires pointercancel when
  // it reclaims the gesture as a scroll, and without handling it the drag
  // would stick mid-way (the "short jerk"). touch-action: none on the grab
  // zone stops most cancels; this makes the rest graceful.
  const release = useCallback(() => {
    const s = st.current;
    if (!s) return;
    st.current = null;
    const dy = Math.max(0, s.y - s.y0);
    if (dy > threshold || s.vy > velocity) {
      haptic.tap();
      setPhase("leave");
      setDragY(900); // beyond any sheet height; the transition carries it off
      timers.current.rest = setTimeout(onClose, reduced ? 0 : 240);
    } else {
      // Settle: switch the transition ON this frame (dragY unchanged), then
      // drive it to 0 next frame. The one-frame gap is what makes iOS animate
      // the change instead of snapping — the transition-toggle jerk. Return
      // to "rest" after so the transform is dropped (seamless chin again).
      setPhase("settle");
      timers.current.raf = requestAnimationFrame(() => setDragY(0));
      timers.current.rest = setTimeout(() => setPhase("rest"), reduced ? 10 : 360);
    }
  }, [onClose, threshold, velocity, reduced]);

  const dragging = phase === "drag";
  // null at rest → caller applies no transform → native paint → seamless chin.
  const sheetStyle = phase === "rest" ? null : {
    transform: `translateY(${dragY}px)`,
    transition: phase === "drag"
      ? "none"
      : phase === "leave"
        ? `transform ${reduced ? 1 : 240}ms cubic-bezier(0.4, 0, 1, 1)`
        : `transform ${reduced ? 1 : 340}ms cubic-bezier(0.16, 1, 0.3, 1)`, // ease-out, no overshoot
  };

  const grabProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: release,
    onPointerCancel: release,
    style: { touchAction: "none", cursor: dragging ? "grabbing" : "grab" },
  };

  return { grabProps, sheetStyle, dragging, dragY };
}
