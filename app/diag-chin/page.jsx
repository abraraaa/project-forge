"use client";

// app/diag-chin/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Isolation instrument for the Safari-browser sheet "chin" (2026-07-09).
// The app's scrim recipe is byte-identical to the state device-verified
// clean on 2026-07-06, yet the chin is back on every modal in browser view —
// so either an iOS point-update changed Safari's chrome sampling, or the
// cause sits outside the scrim CSS. This page renders the candidate recipes
// in isolation; opening each on the device tells us which ingredient
// triggers the chin. Not linked from anywhere; URL-only. Delete when solved.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

const SHEET_BASE = {
  background: "#26221F",
  borderRadius: "20px 20px 0 0",
  padding: "28px 24px calc(32px + env(safe-area-inset-bottom))",
  width: "100%",
  maxWidth: 430,
  color: "#EDEBE7",
  fontFamily: "system-ui, sans-serif",
};

const VARIANTS = {
  A: {
    label: "A — paint ON the fixed scrim (known-bad recipe)",
    scrimStyle: { position: "fixed", inset: 0, background: "rgba(10,9,8,0.82)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 },
    scrimClass: null, animate: false,
  },
  B: {
    label: "B — app recipe verbatim (::before paint + blur)",
    scrimStyle: { display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 },
    scrimClass: "forge-scrim", animate: false,
  },
  C: {
    label: "C — app recipe, blur removed",
    scrimStyle: { display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 },
    scrimClass: "forge-scrim forge-scrim-plain", animate: false,
  },
  D: {
    label: "D — app recipe + slideUp entrance animation",
    scrimStyle: { display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 },
    scrimClass: "forge-scrim", animate: true,
  },
};

export default function DiagChin() {
  const [open, setOpen] = useState(null);
  const v = open ? VARIANTS[open] : null;
  return (
    <div style={{ minHeight: "100vh", maxWidth: 430, margin: "0 auto", padding: "52px 24px", color: "#EDEBE7", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6B6560", marginBottom: 6 }}>Chin diagnostic</div>
      <div style={{ fontSize: 22, fontWeight: 300, marginBottom: 12 }}>Which sheet shows the chin?</div>
      <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6, marginBottom: 24 }}>
        Open each variant in Safari (browser, not the installed app) and note
        whether the band below the sheet appears. A = paint on the fixed
        element itself, the recipe the docs call bad. B = exactly what the
        app ships. C = B without blur. D = B plus the entrance animation.
      </p>
      {Object.entries(VARIANTS).map(([k, def]) => (
        <button key={k} onClick={() => setOpen(k)}
          style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 10, padding: "14px 16px", background: "#1A1714", border: "1px solid #403C38", borderRadius: 12, color: "#E0956A", fontSize: 14, cursor: "pointer" }}>
          {def.label}
        </button>
      ))}
      {v && (
        <div className={v.scrimClass || undefined} onClick={() => setOpen(null)} style={v.scrimStyle}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ ...SHEET_BASE, animation: v.animate ? "slideUp 280ms cubic-bezier(0.22,1,0.36,1)" : "none" }}>
            <div style={{ fontSize: 20, fontWeight: 300, marginBottom: 8 }}>Variant {open}</div>
            <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6 }}>
              Look at the strip between this sheet&apos;s bottom edge and the
              toolbar. Seamless, or is there a band? Tap outside to close.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
