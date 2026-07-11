"use client";

// app/diag-chin/page.jsx — v3
// ─────────────────────────────────────────────────────────────────────────────
// Isolation instrument for the Safari-browser sheet "chin" (2026-07-09).
// v1: paint/blur/animation recipes all seamless — sheet CSS innocent.
// v2: overscroll-contain, aria/focus-on-open, and mount wrapper all clean;
//     the REAL BreatherModal gaps ON THE DIAG PAGE — and only from the
//     second open onward (first open clean). The trigger travels with the
//     component and is STATEFUL across open/close cycles.
// v3 bisects the two remaining ingredients BreatherModal has that cleared
// variants lacked — the slideUp transform entrance and the full useModalA11y
// lifecycle (focus restore on close, re-focus on reopen) — and upgrades the
// instrument: a FLOATING readout measures whatever sheet is open (including
// the real modal, which v2 couldn't measure) and keeps per-open gap history,
// so "first clean, then fails" shows as numbers. URL-only; delete when solved.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import BreatherModal from "@/components/BreatherModal";
import { useModalA11y } from "@/lib/a11y";

const SHEET_BASE = {
  background: "#23201B",
  borderRadius: "20px 20px 0 0",
  padding: "28px 24px calc(32px + env(safe-area-inset-bottom))",
  width: "100%",
  maxWidth: 430,
  color: "#EDEBE7",
  fontFamily: "system-ui, sans-serif",
  minHeight: "38vh",
  outline: "none",
};

// Floating fixed readout, OUTSIDE any sheet — measures the currently-open
// sheet ([data-diag-sheet] or the real modal's [role="dialog"]) against the
// viewport, and appends to a per-variant gap history that survives closes.
function FloatingReadout({ openId, history }) {
  const [g, setG] = useState(null);
  useEffect(() => {
    if (!openId) {
      // Clearing display state when the sheet closes — async so the effect
      // body itself doesn't set state (react-hooks/set-state-in-effect).
      const t0 = setTimeout(() => setG(null), 0);
      return () => clearTimeout(t0);
    }
    let done = false;
    const read = () => {
      if (done) return;
      const el = document.querySelector("[data-diag-sheet]") || document.querySelector('[role="dialog"]');
      const rect = el ? el.getBoundingClientRect() : null;
      const gap = rect ? Math.round(window.innerHeight - rect.bottom) : null;
      const vv = window.visualViewport;
      setG({
        gap,
        innerH: Math.round(window.innerHeight),
        vvH: vv ? Math.round(vv.height) : null,
        vvTop: vv ? Math.round(vv.offsetTop) : null,
        scrollY: Math.round(window.scrollY),
        active: (document.activeElement?.tagName || "?") + (document.activeElement === document.body ? "(body)" : ""),
      });
      if (gap !== null) history.current[openId] = [...(history.current[openId] || []), gap].slice(-6);
    };
    // Sample after the entrance settles; keep sampling on viewport changes.
    const t1 = setTimeout(read, 500);
    const t2 = setTimeout(read, 1200);
    window.visualViewport?.addEventListener("resize", read);
    return () => { done = true; clearTimeout(t1); clearTimeout(t2); window.visualViewport?.removeEventListener("resize", read); };
  }, [openId, history]);
  if (!openId || !g) return null;
  return (
    <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: 8, right: 8, zIndex: 9999, pointerEvents: "none", background: "rgba(10,9,8,0.92)", border: "1px solid #403C38", borderRadius: 10, padding: "8px 10px", fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.6, color: "#E0956A" }}>
      <strong>{openId}</strong> · gap {g.gap}px · innerH {g.innerH} · vvH {g.vvH} · vvTop {g.vvTop} · scrollY {g.scrollY} · focus {g.active}
      <br />gap history {openId}: [{(history.current[openId] || []).join(", ")}]
    </div>
  );
}

// Two sheet components so the useModalA11y hook (whose focus save/restore
// side effects run from its mere presence) exists ONLY in the a11y variants
// — otherwise B and H stop being clean controls.
function SheetBody({ id, anim, a11y, containerRef, ground }) {
  return (
    <div data-diag-sheet ref={containerRef || undefined} onClick={(e) => e.stopPropagation()}
      {...(a11y ? { role: "dialog", "aria-modal": "true", tabIndex: -1 } : {})}
      className={ground ? "forge-sheet-ground" : undefined}
      style={{ ...SHEET_BASE, animation: anim ? "slideUp 280ms cubic-bezier(0.22,1,0.36,1)" : "none" }}>
      <div style={{ fontSize: 20, fontWeight: 300, marginBottom: 8 }}>Variant {id}</div>
      <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6 }}>
        Open me several times. The floating readout at the top shows this
        open&apos;s gap and the history across opens — the chin pattern is
        &quot;first 0, then positive&quot;.
      </p>
    </div>
  );
}

function PlainVariantSheet({ id, onClose, anim, ground }) {
  return (
    <div className="forge-scrim" onClick={onClose}
      style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }}>
      <SheetBody id={id} anim={anim} a11y={false} ground={ground} />
    </div>
  );
}

function A11yVariantSheet({ id, onClose, anim }) {
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  return (
    <div className="forge-scrim" onClick={onClose} onKeyDown={onKeyDown}
      style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }}>
      <SheetBody id={id} anim={anim} a11y containerRef={containerRef} />
    </div>
  );
}

const VARIANTS = {
  B: { label: "B — app recipe verbatim (control, clean in v1+v2)", anim: false, a11y: false },
  H: { label: "H — B + slideUp entrance animation", anim: true, a11y: false },
  J: { label: "J — B + REAL useModalA11y (focus restore on close)", anim: false, a11y: true },
  K: { label: "K — B + slideUp + useModalA11y (BreatherModal's combo)", anim: true, a11y: true },
  T: { label: "T — DETACHED card + slideUp (the production treatment)", anim: true, a11y: false, ground: true },
  R: { label: "R — the REAL BreatherModal component, as shipped", anim: null, a11y: null },
};

export default function DiagChin() {
  const [open, setOpen] = useState(null);
  const history = useRef({});
  return (
    <div style={{ minHeight: "100vh", maxWidth: 430, margin: "0 auto", padding: "52px 24px", color: "#EDEBE7", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6B6560", marginBottom: 6 }}>Chin diagnostic · v3</div>
      <div style={{ fontSize: 22, fontWeight: 300, marginBottom: 12 }}>Open each variant 3+ times</div>
      <p style={{ fontSize: 13, color: "#A09890", lineHeight: 1.6, marginBottom: 24 }}>
        v2 isolated the trigger to the real BreatherModal, stateful across
        opens (first clean, reopens gap). Its two remaining unique
        ingredients: the slideUp transform entrance (H) and the full
        useModalA11y lifecycle (J) — K combines both, matching the real
        modal. The floating readout measures every open, including R, and
        keeps history — screenshot it after a few opens of each.
      </p>
      {Object.entries(VARIANTS).map(([k, def]) => (
        <button key={k} onClick={() => setOpen(k)}
          style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 10, padding: "14px 16px", background: "#1A1714", border: "1px solid #403C38", borderRadius: 12, color: "#E0956A", fontSize: 14, cursor: "pointer" }}>
          {def.label}
        </button>
      ))}

      <div style={{ height: "120vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#403C38", fontSize: 12 }}>
        (scroll spacer — retest with the toolbar minimised)
      </div>

      <FloatingReadout openId={open} history={history} />
      {open === "R" && <BreatherModal onConfirm={() => setOpen(null)} onCancel={() => setOpen(null)} />}
      {open && open !== "R" && (
        VARIANTS[open].a11y
          ? <A11yVariantSheet id={open} onClose={() => setOpen(null)} anim={VARIANTS[open].anim} />
          : <PlainVariantSheet id={open} onClose={() => setOpen(null)} anim={VARIANTS[open].anim} ground={VARIANTS[open].ground} />
      )}
    </div>
  );
}
