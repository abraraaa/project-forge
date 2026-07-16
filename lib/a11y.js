// @ts-check
// lib/a11y.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared accessibility hooks. Extracted from ForgeApp.jsx so other components
// (GlossarySheet, future shared modals) can reuse without duplicating.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from "react";

// Semantic haptic vocabulary. iOS Safari's navigator.vibrate is a no-op
// (returns false silently) — these calls are free on iOS and meaningful
// on Android PWAs. Patterns matched to action weight:
//   toggle  — lightest tick: chip/filter flips, option select
//   tap     — light confirmation: button press, sheet open
//   settle  — soft landing: scroll drum coming to rest on a value
//   commit  — successful submission: log a set, mark a day, confirm RPE
//   alert   — rest timer expired (longer existing pulse)
// Wrapped defensively so undefined navigator / missing vibrate / browser
// rejection never throws into a tap handler.
export const haptic = {
  toggle: () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(6); } catch { /* noop */ } },
  tap:    () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10); } catch { /* noop */ } },
  settle: () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([6, 20, 10]); } catch { /* noop */ } },
  commit: () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([8, 30, 20]); } catch { /* noop */ } },
  alert:  () => { try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(200); } catch { /* noop */ } },
};

// useGrainTouch — tactility batch 3 (Home until device-verified). Returns
// pointer handlers that paint a warm radial lift at the touch point via the
// .forge-grain-touch CSS (globals.css). Compose the className yourself:
// `${grain.className} forge-press`.
//
// TWO LOAD-BEARING MECHANISMS (the first shipped cut lacked both and was
// invisible on device, 2026-07-08):
//   1. The print is a DATA ATTRIBUTE (data-grain-on), never a class. Every
//      wired Home card re-renders Home on tap, and React rewrites className
//      on re-render — a class-based print was wiped ~80ms into every tap.
//      React's diffing never touches attributes it didn't render (the
//      --gx/--gy custom props survive for the same reason).
//   2. Commit-on-tap: a real tap is ~70ms, far shorter than the bloom.
//      Release schedules removal for GRAIN_HOLD_MS after POINTERDOWN, so a
//      quick tap still buys the full 60ms bloom + 480ms exhale (~0.9s
//      visible); a long hold releases naturally on lift.
// Timer + press timestamp live as element expandos — pure DOM writes in
// event handlers, no React state, so pressing never re-renders the card.
const GRAIN_HOLD_MS = 420;
export function useGrainTouch() {
  const down = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      el.style.setProperty("--gx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      el.style.setProperty("--gy", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    }
    clearTimeout(el._grainTimer);
    el._grainDownAt = Date.now();
    el.setAttribute("data-grain-on", "");
  };
  const release = (e) => {
    const el = e.currentTarget;
    const remaining = Math.max(0, GRAIN_HOLD_MS - (Date.now() - (el._grainDownAt || 0)));
    clearTimeout(el._grainTimer);
    if (remaining === 0) {
      el.removeAttribute("data-grain-on");
    } else {
      el._grainTimer = setTimeout(() => el.removeAttribute("data-grain-on"), remaining);
    }
  };
  return {
    className: "forge-grain-touch",
    onPointerDown: down,
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: release,
  };
}

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

// useInlineModalA11y — same contract and behaviour as useModalA11y, but for a
// modal that is CONDITIONALLY RENDERED inside a persistently-mounted parent
// (e.g. ProfileScreen's wipe-confirm / passkey-auth sheets) rather than being
// its own mount/unmount component. useModalA11y keys focus-save/restore on
// mount, which never fires for an inline modal; this keys them on `isOpen`.
// Call it unconditionally at the top of the component and wire the returned
// ref + onKeyDown when the modal renders. Deliberately NOT refactored to share
// useModalA11y's body — that hook backs 13 shipped sheets and is left untouched.
export function useInlineModalA11y(isOpen, onClose) {
  const containerRef = useRef(null);
  const prevFocusRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
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
  }, [isOpen]);

  const onKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      if (onClose) { e.stopPropagation(); onClose(); }
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
