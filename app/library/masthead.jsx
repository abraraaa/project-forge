"use client";

// app/library/masthead.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The library's masthead as a client island so the About disclosure can obey
// both §12.2 rules at once: the WORD sits at the end of the kicker line, but
// the open PANEL drops in after the support line — kicker → title → support
// stay intact. (A native <details> can't split its summary from its panel
// across siblings.) The island SSRs, so the static export keeps the full
// masthead text for crawlers.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";

export default function LibraryMasthead({ count }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 13, color: T.ink2, marginBottom: 8 }}>
        <span><span style={{ fontFamily: T.measured, fontSize: 12 }}>{count}</span> movements</span>
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontFamily: T.text, fontSize: 12, fontWeight: 500, color: open ? T.ink : T.ink3, textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: T.rule, lineHeight: 1 }}>
          About
        </button>
      </div>
      <h1 style={{ ...DISPLAY, fontSize: 42, color: T.ink, margin: 0 }}>
        The library
      </h1>
      <p style={{ fontSize: 15, color: T.ink2, marginTop: 14, lineHeight: 1.6 }}>
        What each lift actually trains.
      </p>
      {open && (
        <p style={{ fontSize: 14, color: T.ink2, marginTop: 10, lineHeight: 1.6, paddingTop: 10, borderTop: `1px solid ${T.ruleFaint}` }}>
          Each movement carries the weighted muscle contributions Heatwayve
          uses to audit your training volume — a squat isn&apos;t &quot;legs&quot;,
          it&apos;s quads first, glutes and hamstrings meaningfully, core along
          for the ride. The same numbers the app computes with, published.
        </p>
      )}
    </div>
  );
}
