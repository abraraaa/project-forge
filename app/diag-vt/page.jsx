"use client";

// app/diag-vt/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// View-transition diagnostic. Originally built to isolate the cross-fade
// dim that wouldn't go away; the cross-fade has since been replaced with
// a slide transition (per a user call after the dim persisted across six
// fixes), so the dim hypotheses below are historical.
//
// The body-class toggle infrastructure is still useful for any future
// view-transition investigation, so the page is kept. The `?status` flag
// is now inert (the body::before status-bar recipe it targeted has been
// removed per a WebKit dev's guidance — iOS PWAs don't support drawing
// content behind the status bar). Leaving the flag for parity; it's a
// no-op until / unless we re-introduce a named element to toggle.
//
// What to do here:
//
//   1. Open /diag-vt in the deployed PWA (or in Safari directly).
//   2. Tap "Swap screens" repeatedly. Watch for any motion artefact.
//   3. Use the URL flags below to toggle layers if investigating:
//
//        /diag-vt              clean baseline (grain off)
//        /diag-vt?grain        enable grain layer for this route
//        /diag-vt?nopl         (historical: would have disabled
//                              mix-blend-mode plus-lighter, currently
//                              inert since plus-lighter isn't used)
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

const A_BG = "#221A14"; // warm-dark
const B_BG = "#141A22"; // cool-dark — visibly different so a "dim" reads clearly

export default function DiagVT() {
  const [screen, setScreenRaw] = useState("A");
  const [swaps, setSwaps] = useState(0);
  const [flags, setFlags] = useState({ grain: false, status: false, nopl: false });

  // Read URL flags on mount (and on hashchange so flicking flags is cheap).
  useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(window.location.search);
      setFlags({
        grain:  p.has("grain"),
        status: p.has("status"),
        nopl:   p.has("nopl"),
      });
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  // Toggle body classes so globals.css can suppress / restore the grain
  // overlay and the status-bar body::before for this route. The classes
  // are added in this component's effect, never globally — leaves the rest
  // of the app untouched.
  useEffect(() => {
    const body = document.body;
    body.classList.add("forge-diag");
    if (!flags.grain)  body.classList.add("forge-diag-no-grain");
    if (!flags.status) body.classList.add("forge-diag-no-statusbar");
    if (flags.nopl)    body.classList.add("forge-diag-no-pluslighter");
    return () => {
      body.classList.remove(
        "forge-diag",
        "forge-diag-no-grain",
        "forge-diag-no-statusbar",
        "forge-diag-no-pluslighter",
      );
    };
  }, [flags.grain, flags.status, flags.nopl]);

  const setScreen = useCallback((next) => {
    setSwaps((n) => n + 1);
    if (typeof document === "undefined" || !document.startViewTransition) {
      setScreenRaw(next);
      return;
    }
    document.startViewTransition(() => flushSync(() => setScreenRaw(next)));
  }, []);

  const swap = useCallback(() => setScreen(screen === "A" ? "B" : "A"), [screen, setScreen]);

  const bg = screen === "A" ? A_BG : B_BG;
  const label = screen === "A" ? "Screen A" : "Screen B";

  return (
    <div style={{
      minHeight: "100vh",
      background: bg,
      color: "#EDEBE7",
      padding: "calc(env(safe-area-inset-top) + 32px) 24px 32px",
      display: "flex",
      flexDirection: "column",
      gap: 24,
      transition: "none",  // no CSS transition — only the view-transition cross-fade
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        View-transition diagnostic
      </div>

      <div style={{ fontSize: 48, fontWeight: 300, lineHeight: 1.1 }}>{label}</div>

      <div style={{ fontSize: 14, opacity: 0.8, lineHeight: 1.5 }}>
        Tap below. The screen-bg cross-fades from warm to cool. With <code>plus-lighter</code>
        working, the midpoint should stay perceptually as bright as either end-state.
        If you see a darker dip at midpoint, plus-lighter isn&apos;t doing its job here.
      </div>

      <button onClick={swap} style={{
        padding: "16px 24px",
        background: "rgba(255,255,255,0.08)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 12,
        color: "#EDEBE7",
        fontSize: 16,
        fontWeight: 500,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}>
        Swap screens ({swaps})
      </button>

      <div style={{ fontSize: 12, lineHeight: 1.7, opacity: 0.7, marginTop: "auto" }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Active flags</div>
        <div>grain: <strong>{flags.grain ? "on" : "OFF"}</strong></div>
        <div>status-bar blur: <strong>{flags.status ? "on" : "OFF"}</strong></div>
        <div>plus-lighter: <strong>{flags.nopl ? "OFF" : "on"}</strong></div>
        <div style={{ marginTop: 12, opacity: 0.8 }}>
          Toggle via URL: <code>?grain</code> <code>?status</code> <code>?nopl</code>
        </div>
      </div>
    </div>
  );
}
