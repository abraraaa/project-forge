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
  { id: "lift",    label: "Log set", note: "SDR neutral lift — --commit raised 12% toward white. The fallback where the panel has no P3." },
  // Wide gamut, not high range. Standalone has no headroom above SDR white
  // (confirmed on release iOS 27, 2026-09-22), so these probe the ceiling
  // that IS reachable: chroma past sRGB on a P3 panel. Each has an sRGB
  // fallback so it renders everywhere; the P3 form wins where supported.
  { id: "p3-oxide", label: "Log set", note: "P3 oxide — what ships (--press-lift) on a wide-gamut panel. Compare against \u2018lift\u2019 above: same shape, more colour, no more light." },
  { id: "p3-warm",  label: "Log set", note: "P3 warm lift — --commit mixed toward a P3 warm white instead of sRGB white. Should read richer, not brighter." },
  { id: "oklch",    label: "Log set", note: "oklch, chroma out of sRGB — no P3 keyword, just a colour sRGB cannot express. Safari gamut-maps it to the panel." },
  { id: "p3-ring",  label: "Log set", note: "P3 edge — the light on the rim, not under the thumb. The one shape a bloom has not tried." },
  { id: "p3-quiet", label: "A quiet touchable", note: "Bone surface, P3 warm tint. Does a wider gamut buy the quiet case anything at all." },
];

// A plausible 8-week e1RM run, flat patch included.
const SPARK_SERIES = [100, 102.5, 102.5, 105, 104, 107.5, 110, 112.5];
const SPARKS = [
  { id: "ship", note: "What ships — ink line, heat dots." },
  { id: "p3-line", note: "P3 line — the stroke carries the colour; dots stay as they are." },
  { id: "p3-dot", note: "P3 latest point — ink line, only today's dot is wide gamut. The most restrained." },
  { id: "p3-ramp", note: "P3 ramp — the drill-down's heat gradient with its chroma raised." },
];

function SparkSample({ variant }) {
  const W = 320, H = 64, n = SPARK_SERIES.length;
  const min = Math.min(...SPARK_SERIES), max = Math.max(...SPARK_SERIES);
  const x = (i) => 6 + (i * (W - 12)) / (n - 1);
  const y = (v) => H - 8 - ((H - 16) * (v - min)) / (max - min);
  const d = SPARK_SERIES.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const gid = `ramp-${variant}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} className={`spark spark-${variant}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className="ramp-1" />
          <stop offset="0.6" className="ramp-2" />
          <stop offset="1" className="ramp-3" />
        </linearGradient>
      </defs>
      <path d={d} fill="none" className="spark-line" style={variant === "p3-ramp" ? { stroke: `url(#${gid})` } : undefined}
        strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {SPARK_SERIES.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 3.6 : 2.4}
          className={i === n - 1 ? "spark-last" : "spark-dot"} stroke="var(--ground)" strokeWidth="1.4" />
      ))}
    </svg>
  );
}

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

        <h2 style={{ fontSize: 15, margin: "36px 0 6px" }}>Sparklines in wide gamut</h2>
        <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 14px" }}>
          Richer colour, same brightness — and light mode only: in dark mode every
          variant falls back to what ships, so the bed-time scroll stays quiet.
          Flip Appearance to compare.
        </p>
        {SPARKS.map((v) => (
          <div key={v.id} style={{ marginBottom: 22 }}>
            <SparkSample variant={v.id} />
            <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.55, margin: "6px 2px 0" }}>{v.note}</p>
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
          colour to CSS. Confirmed on release 27 (2026-09-22): only the SDR
          panels light up in standalone. The P3 panels test the other axis —
          gamut, not range — which standalone does reach.
        </p>
      </div>
    </div>
  );
}

// Plain CSS: a style-object serialiser drops these properties silently.
const CSS_TEXT = `
/* Sparklines. --spark-* hold what ships; the P3 block below raises chroma in
   LIGHT mode only (light-dark's dark half is the shipped colour). */
.spark { --spark-line: var(--ink-2); --spark-dot: var(--heat-2); --spark-last: var(--heat-2);
  --ramp-1: var(--heat-1); --ramp-2: var(--heat-2); --ramp-3: var(--heat-3); }
.spark-line { stroke: var(--spark-line); }
.spark-dot { fill: var(--spark-dot); }
.spark-last { fill: var(--spark-last); }
.ramp-1 { stop-color: var(--ramp-1); } .ramp-2 { stop-color: var(--ramp-2); } .ramp-3 { stop-color: var(--ramp-3); }
.spark-p3-ramp .spark-dot, .spark-p3-ramp .spark-last { fill: var(--ramp-2); }
@supports (color: color(display-p3 1 1 1)) {
  .spark-p3-line { --spark-line: light-dark(oklch(64% 0.15 38), var(--ink-2)); }
  .spark-p3-dot  { --spark-last: light-dark(oklch(60% 0.19 36), var(--heat-2)); }
  .spark-p3-ramp {
    --ramp-1: light-dark(oklch(75% 0.11 40), var(--heat-1));
    --ramp-2: light-dark(oklch(64% 0.15 38), var(--heat-2));
    --ramp-3: light-dark(oklch(53% 0.18 34), var(--heat-3));
  }
}

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




/* ── Wide gamut. Fallback first, P3 form inside @supports. ── */
.bloom-p3-oxide::before {
  background: radial-gradient(120px circle at var(--x) var(--y), #E8A98F, transparent 72%);
}
.bloom-p3-warm::before {
  background: radial-gradient(120px circle at var(--x) var(--y),
    color-mix(in oklab, var(--commit) 84%, #FFF3E8), transparent 70%);
}
.bloom-oklch::before {
  background: radial-gradient(120px circle at var(--x) var(--y), #F0A27F, transparent 72%);
  background: radial-gradient(120px circle at var(--x) var(--y), oklch(80% 0.19 45), transparent 72%);
}
.bloom-p3-ring { box-shadow: inset 0 0 0 1px transparent, 0 1px 2px rgba(36,28,25,0.12), 0 8px 22px rgba(36,28,25,0.10); transition: transform 380ms cubic-bezier(0.22,1,0.36,1), box-shadow 380ms cubic-bezier(0.22,1,0.36,1); }
.bloom-p3-ring::before { background: none; }
.bloom-p3-ring.is-down { box-shadow: inset 0 0 0 2px #F2B394, inset 0 0 18px rgba(242,179,148,0.55), 0 1px 2px rgba(36,28,25,0.12), 0 8px 22px rgba(36,28,25,0.10); transition-duration: 90ms; }
.bloom-p3-quiet {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(36,28,25,0.10), 0 6px 18px rgba(36,28,25,0.06);
}
.bloom-p3-quiet::before {
  background: radial-gradient(120px circle at var(--x) var(--y), #F4E4D6, transparent 74%);
}
@supports (color: color(display-p3 1 1 1)) {
  .bloom-p3-oxide::before {
    background: radial-gradient(120px circle at var(--x) var(--y),
      color(display-p3 0.98 0.60 0.44), transparent 72%);
  }
  .bloom-p3-warm::before {
    background: radial-gradient(120px circle at var(--x) var(--y),
      color-mix(in oklab, var(--commit) 84%, color(display-p3 1 0.95 0.88)), transparent 70%);
  }
  .bloom-p3-ring.is-down {
    box-shadow: inset 0 0 0 2px color(display-p3 1 0.68 0.50), inset 0 0 18px color(display-p3 1 0.68 0.50 / 0.55),
      0 1px 2px rgba(36,28,25,0.12), 0 8px 22px rgba(36,28,25,0.10);
  }
  .bloom-p3-quiet::before {
    background: radial-gradient(120px circle at var(--x) var(--y),
      color(display-p3 0.99 0.90 0.80), transparent 74%);
  }
}

`;
