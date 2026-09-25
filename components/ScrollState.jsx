"use client";

// Marks <html data-scrolled> once the reader is past the top of the page, for
// the headline compression in globals.css. Passive, one read per frame, and
// it writes only when the state flips. Hysteresis — on past 24px, off above
// 8px — so toolbar jitter and the end-of-page bounce can't make it flicker.
import { useEffect } from "react";

const ON = 24, OFF = 8;

/** Pure: the next state from the current one and the scroll offset. */
export function nextScrolled(scrolled, y) {
  if (!scrolled && y > ON) return true;
  if (scrolled && y < OFF) return false;
  return scrolled;
}

export default function ScrollState() {
  useEffect(() => {
    const root = document.documentElement;
    let scrolled = false, frame = 0;
    const apply = () => {
      frame = 0;
      const next = nextScrolled(scrolled, window.scrollY);
      if (next === scrolled) return;
      scrolled = next;
      if (next) root.setAttribute("data-scrolled", ""); else root.removeAttribute("data-scrolled");
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      root.removeAttribute("data-scrolled");
    };
  }, []);
  return null;
}
