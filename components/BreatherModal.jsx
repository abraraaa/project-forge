"use client";

// components/BreatherModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// "Need a breather?" — the declare-a-pause modal. Shared by two entry points:
// the Home absence nudge and the Profile utility row. Pure presentation: it
// collects an optional reason and calls onConfirm(reasonId | null); the parent
// (ForgeApp) owns Bk.start + the push. Voice is permission, never confession —
// see lib/breaks.js. Copy signed off 2026-07-06.
//
// NOTE — no drag-to-dismiss. A drag needs a transform on the sheet, which
// makes iOS Safari composite it into its own layer, and a composited
// fixed/bottom element CLIPS the safe-area zone — reopening the very chin
// band our seamless sheets exist to avoid (confirmed 2026-07-07, reproduced
// by forcing a composite layer; neither box-shadow nor a filler could paint
// the clipped region back). Dismissal stays tap-outside / Escape / "Not now",
// exactly like every other seamless sheet (e.g. BodyweightEditModal).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T } from "@/lib/tokens";
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
        className="forge-sheet-ground" style={{ background: T.bg2, borderRadius: `${T.r.lg}px ${T.r.lg}px 0 0`, padding: "28px 24px calc(32px + env(safe-area-inset-bottom))", width: "100%", maxWidth: 430, borderTop: `1px solid ${T.bg3}`, animation: `slideUp 280ms ${T.ease}`, outline: "none" }}>
        <div id={titleId} style={{ fontFamily: T.serif, fontSize: 26, fontWeight: 300, lineHeight: 1.2, marginBottom: 10 }}>
          Need a <span style={{ fontStyle: "italic", color: T.coral }}>breather?</span>
        </div>
        <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 22 }}>
          Rest is a training variable, not a lapse. Tell Forge you&apos;re stepping back and your
          rhythm holds where it is. It picks up the moment you train again.
        </p>

        <div style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
          Care to say?
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 26 }}>
          {REASONS.map((r) => {
            const on = reason === r.id;
            return (
              <button key={r.id} onClick={() => { haptic.toggle(); setReason(on ? null : r.id); }}
                style={{ padding: "9px 14px", background: on ? T.coral : T.bg3, border: `1px solid ${on ? T.coral : T.bg4}`, borderRadius: T.r.pill, cursor: "pointer", fontSize: 13, fontWeight: 500, color: on ? T.bg0 : T.text2, fontFamily: T.sans, transition: `all 160ms ${T.ease}` }}>
                {r.label}
              </button>
            );
          })}
        </div>

        <button onClick={() => { haptic.commit(); onConfirm(reason); }}
          style={{ width: "100%", padding: "15px 20px", background: T.coral, border: "none", borderRadius: T.r.lg, cursor: "pointer", fontFamily: T.serif, fontSize: 18, fontWeight: 400, color: T.bg0, boxShadow: `0 12px 40px ${T.strength.glow}` }}>
          Breathe easy
        </button>
        <button onClick={onCancel}
          style={{ width: "100%", marginTop: 12, padding: "12px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.text3, fontFamily: T.sans }}>
          Not now
        </button>
      </div>
    </div>
  );
}
