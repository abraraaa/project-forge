"use client";

// app/diag-hdr/page.jsx
// Instrument. Touch-bloom candidates on the real commit surface, plus what the
// device reports. Press is driven by pointer events — WebKit only applies
// :active reliably to genuine interactive elements. Nothing here is imported
// by the app; glows stay on the never-list.

import { useEffect, useState } from "react";

const PROBES = [
  ["color(display-p3 …)", "color", "color(display-p3 1 1 1)"],
  ["color(rec2100-hlg …)", "color", "color(rec2100-hlg 1 1 1)"],
  ["color(rec2100-pq …)", "color", "color(rec2100-pq 1 1 1)"],
  ["dynamic-range-limit: no-limit", "dynamic-range-limit", "no-limit"],
];

// Two SDR candidates: up the heat ramp, and a neutral lift off it.
const PANELS = [
  { id: "control", label: "Log set", note: "Control — exactly what ships. Scale only, no light." },
  { id: "sdr",     label: "Log set", note: "SDR, up the heat ramp — blooms toward heat-1, which encodes \u2018easy\u2019 elsewhere. What was first built." },
  { id: "lift",    label: "Log set", note: "SDR, neutral lift — --commit raised 12% toward white, off the ramp. What ships. Should read the same, and borrows no meaning." },
  { id: "hlg-low", label: "Log set", note: "HDR restrained — same hue, just past diffuse white." },
  { id: "hlg-high",label: "Log set", note: "HDR assertive — the LinkedIn end of the dial, here so the bad option is on screen beside the good one." },
  { id: "vellum",  label: "Log set", note: "Torch behind vellum — the light sits UNDER the surface rather than on it. Lit, not emitting." },
  { id: "quiet",   label: "A quiet touchable", note: "The other case: a bone surface, where today only a tint is allowed." },
];

export default function DiagHdrPage() {
  const [env, setEnv] = useState(null);
  const [down, setDown] = useState(null);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-once capability
     read, same shape as /diag-safe-area: these values exist only in a real
     browser and reporting them is the entire purpose of the page. */
  useEffect(() => {
    const supports = (prop, val) => {
      try { return String(CSS?.supports?.(prop, val)); } catch { return "threw"; }
    };
    const mq = (q) => {
      try { return String(window.matchMedia(q).matches); } catch { return "threw"; }
    };
    setEnv({
      probes: PROBES.map(([label, prop, val]) => [label, supports(prop, val)]),
      dynamicRange: mq("(dynamic-range: high)"),
      videoDynamicRange: mq("(video-dynamic-range: high)"),
      p3: mq("(color-gamut: p3)"),
      rec2020: mq("(color-gamut: rec2020)"),
    });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The bloom centres on the contact point — a halo pinned to the middle of a
  // button is testing something nobody asked about.
  const track = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
  };

  return (
    <div style={{ background: "var(--ground)", color: "var(--ink)", minHeight: "100%", fontFamily: "system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: CSS_TEXT }} />
      <div style={{ maxWidth: 430, margin: "0 auto", padding: "40px 20px 64px" }}>
        <h1 style={{ fontSize: 21, margin: "0 0 6px" }}>Touch bloom on the commit surface</h1>
        <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, margin: "0 0 28px" }}>
          Press and hold each button. The bloom follows your thumb. These are
          real commit buttons at real size — judge them in the room you train in,
          not on a desk.
        </p>

        {PANELS.map((p) => (
          <div key={p.id} style={{ marginBottom: 24 }}>
            <button
              type="button"
              className={`bloom bloom-${p.id}${down === p.id ? " is-down" : ""}`}
              onPointerDown={(e) => { track(e); setDown(p.id); }}
              onPointerMove={(e) => { if (down === p.id) track(e); }}
              onPointerUp={() => setDown(null)}
              onPointerCancel={() => setDown(null)}
              onPointerLeave={() => setDown(null)}
            >
              <span className="bloom-label">{p.label}</span>
            </button>
            <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.55, margin: "8px 2px 0" }}>{p.note}</p>
          </div>
        ))}

        <h2 style={{ fontSize: 15, margin: "36px 0 10px" }}>What this device reports</h2>
        {!env ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>Reading…</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {[
                ...env.probes,
                ["media (dynamic-range: high)", env.dynamicRange],
                ["media (video-dynamic-range: high)", env.videoDynamicRange],
                ["media (color-gamut: p3)", env.p3],
                ["media (color-gamut: rec2020)", env.rec2020],
              ].map(([k, v]) => (
                <tr key={k} style={{ borderBottom: "1px solid var(--rule)" }}>
                  <td style={{ padding: "7px 0", color: "var(--ink-3)" }}>{k}</td>
                  <td style={{ padding: "7px 0", textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.6, marginTop: 22 }}>
          Measured 2026-08-30 on iOS 27: both rec2100 rows read{" "}
          <code>false</code> in browser AND standalone, so Safari exposes no HDR
          colour to CSS. The HDR panels above fall back to ordinary colour. HDR
          images and video go through a different pipeline entirely.
        </p>
      </div>
    </div>
  );
}

// Plain CSS: a style-object serialiser drops these properties silently.
const CSS_TEXT = `
.bloom {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 56px;
  border: none;
  border-radius: 3px;
  overflow: hidden;
  cursor: pointer;
  font-family: inherit;
  -webkit-tap-highlight-color: transparent;
  background: var(--commit);
  color: var(--commit-ink);
  box-shadow: 0 1px 2px rgba(36,28,25,0.12), 0 8px 22px rgba(36,28,25,0.10);
  transition: transform 380ms cubic-bezier(0.22,1,0.36,1);
  --x: 50%; --y: 50%;
}
.bloom.is-down { transform: scale(0.99); transition-duration: 90ms; }
.bloom-label { position: relative; z-index: 2; font-size: 17px; font-weight: 500; }

.bloom::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0;
  z-index: 1;
  pointer-events: none;
  transition: opacity 380ms cubic-bezier(0.22,1,0.36,1);
}
.bloom.is-down::before { opacity: 1; transition-duration: 90ms; }

/* Control: no light. */
.bloom-control::before { background: none; }

/* SDR — oxide travelling its own ramp, not a wash toward white. */
.bloom-sdr::before {
  background: radial-gradient(120px circle at var(--x) var(--y),
    #D3A492, transparent 72%);
}

/* What ships: same rule as .forge-lift in globals.css. 12% is the lift that
   stays furthest from any heat step in both modes. */
.bloom-lift::before {
  background: radial-gradient(120px circle at var(--x) var(--y),
    color-mix(in oklab, var(--commit) 88%, white), transparent 70%);
}

.bloom-hlg-low::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(120px circle at var(--x) var(--y),
    color(rec2100-hlg 0.84 0.52 0.40), transparent 72%);
}

.bloom-hlg-high::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(140px circle at var(--x) var(--y),
    color(rec2100-hlg 1 0.72 0.55), transparent 76%);
}

/* Light underneath, surface over the top: lit rather than emitting. */
.bloom-vellum::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(140px circle at var(--x) var(--y),
    color(rec2100-hlg 0.96 0.66 0.50), transparent 74%);
}
.bloom-vellum::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: color-mix(in srgb, var(--commit) 82%, transparent);
}

/* The quiet case: bone, tint only today. */
.bloom-quiet {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(36,28,25,0.10), 0 6px 18px rgba(36,28,25,0.06);
}
.bloom-quiet::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(120px circle at var(--x) var(--y),
    color(rec2100-hlg 0.90 0.86 0.80), transparent 74%);
}
`;
