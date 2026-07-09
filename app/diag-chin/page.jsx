"use client";

// app/diag-chin/page.jsx — v2
// ─────────────────────────────────────────────────────────────────────────────
// Isolation instrument for the Safari-browser sheet "chin" (2026-07-09).
// v1 finding (device-verified): all four paint/blur/animation recipes are
// SEAMLESS — they run clean under the toolbar to the physical bottom. Real
// modals terminate ~100pt above it with a black band below (breather
// screenshot). So the sheet CSS is innocent; the fixed element's COORDINATE
// SYSTEM differs between a bare page and the real mount context. v2 bisects
// the real deltas and adds a geometry readout INSIDE each sheet so the
// screenshot carries numbers, not interpretation. URL-only; delete when solved.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import BreatherModal from "@/components/BreatherModal";

const SHEET_BASE = {
  background: "#23201B",
  borderRadius: "20px 20px 0 0",
  padding: "28px 24px calc(32px + env(safe-area-inset-bottom))",
  width: "100%",
  maxWidth: 430,
  color: "#EDEBE7",
  fontFamily: "system-ui, sans-serif",
};

// Live geometry, rendered inside the sheet: if the sheet's bottom edge sits
// above the viewport bottom, the gap is printed — no eyeballing tone bands.
function GeometryReadout() {
  const [g, setG] = useState(null);
  useEffect(() => {
    const read = () => {
      const el = document.querySelector("[data-diag-sheet]");
      const rect = el ? el.getBoundingClientRect() : null;
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px)";
      document.body.appendChild(probe);
      const safeBottom = Math.round(probe.getBoundingClientRect().height);
      probe.remove();
      setG({
        innerH: Math.round(window.innerHeight),
        vvH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
        docH: Math.round(document.documentElement.clientHeight),
        sheetBottom: rect ? Math.round(rect.bottom) : null,
        gap: rect ? Math.round(window.innerHeight - rect.bottom) : null,
        safeBottom,
      });
    };
    read();
    const t = setTimeout(read, 400); // after entrance settles
    window.visualViewport?.addEventListener("resize", read);
    return () => { clearTimeout(t); window.visualViewport?.removeEventListener("resize", read); };
  }, []);
  if (!g) return null;
  return (
    <div style={{ marginTop: 14, fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.7, color: "#E0956A" }}>
      innerHeight {g.innerH} · visualViewport {g.vvH ?? "—"} · docClient {g.docH}<br />
      sheet bottom {g.sheetBottom} · <strong>gap below sheet {g.gap}px</strong> · env(bottom) {g.safeBottom}px
    </div>
  );
}

function VariantSheet({ id, onClose, scrimClass, scrimStyle, dialogProps, wrap }) {
  // Optional focus-on-open (variant F) — mirrors useModalA11y's behaviour.
  useEffect(() => {
    if (!dialogProps) return;
    const el = document.querySelector("[data-diag-sheet]");
    try { el?.focus({ preventScroll: true }); } catch { /* noop */ }
  }, [dialogProps]);

  const scrim = (
    <div className={scrimClass || undefined} onClick={onClose}
      style={{ ...(scrimClass ? {} : { position: "fixed", inset: 0, background: "rgba(10,9,8,0.82)" }), display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300, ...scrimStyle }}>
      <div data-diag-sheet onClick={(e) => e.stopPropagation()} {...(dialogProps || {})}
        style={{ ...SHEET_BASE, minHeight: "38vh", outline: "none" }}>
        <div style={{ fontSize: 20, fontWeight: 300, marginBottom: 8 }}>Variant {id}</div>
        <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6 }}>
          If the gap below reads 0px and the sheet visually meets the screen
          bottom, this variant is clean. A positive gap = the chin, measured.
        </p>
        <GeometryReadout />
      </div>
    </div>
  );

  // Variant G: mount the same sheet inside a screen-root-like wrapper —
  // the real modals' ancestor shape (capped column, relative, overflow clip).
  if (wrap) {
    return (
      <div style={{ maxWidth: 430, margin: "0 auto", position: "relative", overflow: "clip", minHeight: "50vh" }}>
        {scrim}
      </div>
    );
  }
  return scrim;
}

const VARIANTS = {
  B: { label: "B — app recipe verbatim (v1: seamless — control)", props: { scrimClass: "forge-scrim" } },
  E: { label: "E — B + overscrollBehavior: contain (all real modals have this)", props: { scrimClass: "forge-scrim", scrimStyle: { overscrollBehavior: "contain" } } },
  F: { label: "F — B + role=dialog / aria-modal / focus (real a11y wiring)", props: { scrimClass: "forge-scrim", dialogProps: { role: "dialog", "aria-modal": "true", tabIndex: -1 } } },
  G: { label: "G — B mounted inside a screen-like wrapper", props: { scrimClass: "forge-scrim", wrap: true } },
  R: { label: "R — the REAL BreatherModal component, as shipped", props: null },
};

export default function DiagChin() {
  const [open, setOpen] = useState(null);
  return (
    <div style={{ minHeight: "100vh", maxWidth: 430, margin: "0 auto", padding: "52px 24px", color: "#EDEBE7", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6B6560", marginBottom: 6 }}>Chin diagnostic · v2</div>
      <div style={{ fontSize: 22, fontWeight: 300, marginBottom: 12 }}>Which variant shows a gap?</div>
      <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6, marginBottom: 24 }}>
        v1 cleared paint, blur, and animation — all seamless. v2 bisects what
        real modals have that the bare tests lacked. Each sheet now prints its
        own geometry: <strong style={{ color: "#EDEBE7" }}>&quot;gap below sheet&quot;</strong> is
        the chin, in pixels, no squinting. R is the real breather modal —
        if it gaps here, the trigger travels with the component (E/F name it);
        if it&apos;s clean here but gaps on Profile, the trigger lives in the
        screens&apos; ancestor tree (G corners it).
      </p>
      {Object.entries(VARIANTS).map(([k, def]) => (
        <button key={k} onClick={() => setOpen(k)}
          style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 10, padding: "14px 16px", background: "#1A1714", border: "1px solid #403C38", borderRadius: 12, color: "#E0956A", fontSize: 14, cursor: "pointer" }}>
          {def.label}
        </button>
      ))}

      {/* Tall spacer: real screens scroll, and Safari's toolbar state
          (expanded vs minimised) changes viewport geometry. Scroll down,
          then re-test a variant with the toolbar minimised too. */}
      <div style={{ height: "120vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#403C38", fontSize: 12 }}>
        (scroll spacer — retest variants with the toolbar minimised)
      </div>

      {open === "R" && <BreatherModal onConfirm={() => setOpen(null)} onCancel={() => setOpen(null)} />}
      {open && open !== "R" && <VariantSheet id={open} onClose={() => setOpen(null)} {...VARIANTS[open].props} />}
    </div>
  );
}
