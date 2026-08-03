"use client";

// components/BreatherModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// "Need a breather?" — the declare-a-pause modal. Shared by two entry points:
// the Home absence nudge and the Profile utility row. Pure presentation: it
// collects an optional reason and calls onConfirm(reasonId | null); the parent
// owns Bk.start + the push. Voice is permission, never confession — see
// lib/breaks.js.
//
// NOTE — no drag-to-dismiss. A drag needs a transform on the sheet, which
// makes iOS Safari composite it into its own layer, and a composited
// fixed/bottom element CLIPS the safe-area zone (confirmed 2026-07-07).
// Dismissal stays tap-outside / Escape / "Not now".
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { REASONS } from "@/lib/breaks";
import { useModalA11y, haptic } from "@/lib/a11y";

export default function BreatherModal({ onConfirm, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const [reason, setReason] = useState(null);
  const titleId = "breather-title";

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim"
      style={{ overscrollBehavior: "contain", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{ padding: "26px 24px calc(32px + env(safe-area-inset-bottom))", width: "100%", animation: `slideUp 280ms ${T.ease}`, outline: "none" }}>
        <div id={titleId} style={{ ...DISPLAY, fontSize: 28, color: T.ink, marginBottom: 10 }}>
          A breather
        </div>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 20 }}>
          Need one? Rest is a training variable, not a lapse. Tell Heatwayve you&apos;re stepping back and your
          rhythm holds where it is. It picks up the moment you train again.
        </p>

        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 12 }}>
          Care to say?
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
          {REASONS.map((r) => {
            const on = reason === r.id;
            return (
              <button key={r.id} onClick={() => { haptic.toggle(); setReason(on ? null : r.id); }}
                aria-pressed={on}
                style={{ padding: "9px 14px", background: on ? T.surface : "transparent", border: `1px solid ${on ? "transparent" : T.rule}`, boxShadow: on ? T.elev : "none", borderRadius: T.rSm, cursor: "pointer", fontSize: 13, fontWeight: on ? 500 : 400, color: on ? T.ink : T.ink2, fontFamily: T.text, transition: `background 160ms ${T.ease}` }}>
                {r.label}
              </button>
            );
          })}
        </div>

        <button onClick={() => { haptic.commit(); onConfirm(reason); }}
          style={{ width: "100%", height: 54, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 16, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong }}>
          Breathe easy
        </button>
        <button onClick={onCancel}
          style={{ width: "100%", marginTop: 12, padding: "12px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.ink3, fontFamily: T.text }}>
          Not now
        </button>
      </div>
    </div>
  );
}
