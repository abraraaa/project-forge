"use client";

// app/diag-hdr/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// INSTRUMENT, not a screen. Answers one question: is there a version of a
// touch bloom that reads as a torch behind vellum rather than a LinkedIn
// gain-map advert (boss's bar, 2026-08-21)?
//
// It reports what the device actually supports AND lets you feel each
// candidate, because the bar is aesthetic and no support matrix can settle it.
//
// Gain maps themselves are the wrong tool and are deliberately not tried here:
// ISO 21496-1 attaches a brightening map to an IMAGE asset. You cannot apply
// one to a button — you would be compositing a picture under a thumb. The
// CSS-native route to light above SDR white is the rec2100 colour spaces plus
// dynamic-range-limit, which is what these swatches use.
//
// Nothing here is imported by the app. Glows remain on the never-list
// (lib/tokens.js) unless and until this changes someone's mind.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

const PROBES = [
  ["color(display-p3 …)", "color", "color(display-p3 1 1 1)"],
  ["color(rec2100-hlg …)", "color", "color(rec2100-hlg 1 1 1)"],
  ["color(rec2100-pq …)", "color", "color(rec2100-pq 1 1 1)"],
  ["dynamic-range-limit: no-limit", "dynamic-range-limit", "no-limit"],
  ["dynamic-range-limit: constrained", "dynamic-range-limit", "constrained"],
];

// Each swatch is one hypothesis about the material. The control is first so
// the eye has the current app press to compare against, not a memory of it.
const SWATCHES = [
  { id: "control", name: "Control — what ships today",
    note: "scale(0.99) + press tint. No light at all." },
  { id: "sdr", name: "SDR bloom",
    note: "An ordinary radial highlight. Tests the SHAPE before HDR is involved — if this already reads wrong, brightness will not save it." },
  { id: "hlg-low", name: "HDR bloom — restrained",
    note: "rec2100-hlg just above diffuse white." },
  { id: "hlg-high", name: "HDR bloom — assertive",
    note: "The LinkedIn end of the dial. Included so the bad option is on screen next to the good one." },
  { id: "vellum", name: "Torch behind vellum",
    note: "The light sits UNDER a translucent surface rather than on top of it. Backlit, not emissive — the one that matches the brief." },
];

export default function DiagHdrPage() {
  const [env, setEnv] = useState(null);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-once capability
     read, exactly as /diag-safe-area does it: these values only exist in a
     browser, and the whole point of the page is to report them. */
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
      ua: navigator.userAgent.slice(0, 120),
    });
  }, []);

  // The bloom follows the contact point — "around the area of thumb" is the
  // whole idea, and a halo pinned to an element's centre tests something else.
  const track = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
  };

  return (
    <div style={{ background: "#F2E9E3", color: "#241C19", minHeight: "100%", fontFamily: "system-ui, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: CSS_TEXT }} />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 20px 64px" }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>HDR touch-bloom probe</h1>
        <p style={{ fontSize: 13, color: "#6A5B54", lineHeight: 1.6, margin: "0 0 26px" }}>
          Press and hold each panel. The bloom follows your finger. Judge it in
          the room you actually train in — this is a material question, not a
          numbers one.
        </p>

        {SWATCHES.map((s) => (
          <div key={s.id} style={{ marginBottom: 22 }}>
            <div
              className={`probe probe-${s.id}`}
              onPointerDown={track}
              onPointerMove={track}
            >
              <span className="probe-label">{s.name}</span>
            </div>
            <p style={{ fontSize: 12, color: "#6A5B54", lineHeight: 1.55, margin: "8px 2px 0" }}>{s.note}</p>
          </div>
        ))}

        <h2 style={{ fontSize: 15, margin: "34px 0 10px" }}>What this device reports</h2>
        {!env ? (
          <p style={{ fontSize: 13, color: "#6A5B54" }}>Reading…</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {[
                ...env.probes,
                ["media (dynamic-range: high)", env.dynamicRange],
                ["media (video-dynamic-range: high)", env.videoDynamicRange],
                ["media (color-gamut: p3)", env.p3],
                ["media (color-gamut: rec2020)", env.rec2020],
                ["userAgent", env.ua],
              ].map(([k, v]) => (
                <tr key={k} style={{ borderBottom: "1px solid #E0D2C9" }}>
                  <td style={{ padding: "7px 0", color: "#6A5B54" }}>{k}</td>
                  <td style={{ padding: "7px 0", textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ fontSize: 12, color: "#6A5B54", lineHeight: 1.6, marginTop: 24 }}>
          If the rec2100 rows read <code>false</code>, the HDR panels are
          falling back to ordinary colour and only the SDR and vellum panels
          mean anything. Worth knowing before judging them.
        </p>
      </div>
    </div>
  );
}

// Plain CSS rather than inline styles: dynamic-range-limit and the rec2100
// colour spaces are exactly the sort of thing a style-object serialiser drops
// silently, and a silently-dropped property would make this instrument lie.
const CSS_TEXT = `
.probe {
  position: relative;
  height: 128px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  overflow: hidden;
  background: #FBF6F2;
  box-shadow: 0 1px 2px rgba(36,28,25,0.10), 0 6px 18px rgba(36,28,25,0.06);
  transition: transform 380ms cubic-bezier(0.22,1,0.36,1);
  --x: 50%; --y: 50%;
}
.probe:active { transform: scale(0.99); transition-duration: 90ms; }
.probe-label { font-size: 14px; font-weight: 500; color: #241C19; position: relative; z-index: 2; }

/* The light itself — a child layer so the panel's own surface stays matte. */
.probe::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 380ms cubic-bezier(0.22,1,0.36,1);
  pointer-events: none;
  z-index: 1;
}
.probe:active::before { opacity: 1; transition-duration: 90ms; }

/* Control: no light, tint only — the app's current treatment. */
.probe-control:active { background: #F3E9E2; }

.probe-sdr::before {
  background: radial-gradient(180px circle at var(--x) var(--y),
    rgba(255,255,255,0.92), rgba(255,255,255,0) 70%);
}

.probe-hlg-low::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(180px circle at var(--x) var(--y),
    color(rec2100-hlg 0.80 0.78 0.74), transparent 70%);
}

.probe-hlg-high::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(200px circle at var(--x) var(--y),
    color(rec2100-hlg 1 1 1), transparent 72%);
}

/* Torch behind vellum: the light is UNDER a translucent sheet, so what you
   see is a surface being lit rather than a surface emitting. */
.probe-vellum { background: transparent; }
.probe-vellum::before {
  dynamic-range-limit: no-limit;
  background: radial-gradient(200px circle at var(--x) var(--y),
    color(rec2100-hlg 0.92 0.90 0.86), transparent 74%);
}
.probe-vellum::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background: rgba(251,246,242,0.86);
}
`;
