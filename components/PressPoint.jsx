"use client";

// Feeds the contact point to every press surface (.forge-lift, .forge-tint)
// from one listener, so a new button can't ship with its light centred.
// lib/press-lift.js's per-element handlers still track the drag on the lift.
import { useEffect } from "react";

export default function PressPoint() {
  useEffect(() => {
    const onDown = (/** @type {PointerEvent} */ e) => {
      const el = e.target instanceof Element ? e.target.closest(".forge-lift, .forge-tint") : null;
      if (!(el instanceof HTMLElement)) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--x", `${e.clientX - r.left}px`);
      el.style.setProperty("--y", `${e.clientY - r.top}px`);
    };
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    return () => document.removeEventListener("pointerdown", onDown, { capture: true });
  }, []);
  return null;
}
