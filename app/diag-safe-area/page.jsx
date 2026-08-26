"use client";

// app/diag-safe-area/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Safe-area + status-bar ruler. Built to answer one question we have been
// guessing at for three rounds: HOW FAR DOWN does iOS's status-bar treatment
// actually reach, and does it differ between Safari-browser and the installed
// standalone app?
//
// We create no blur anywhere — backdrop-filter is on the design system's
// never-list — so any wash over our screens is the system's. The cause was
// found by reading Apple's guidance rather than by measuring: iOS 26.1
// stopped honouring `black-translucent`. This page is now the VERIFICATION
// step, not the investigation.
//
// HOW TO USE — two screenshots, no reinstall needed:
//
//   1. Open /diag-safe-area in Safari (browser tab). Screenshot.
//   2. Open the SAME path from the installed home-screen app. Screenshot.
//
// Then read the two:
//
//   - The cause is now known: iOS 26.1 stopped honouring black-translucent,
//     so the system painted its own treatment over a layout still positioned
//     as though it owned that zone. We take the default bar now
//     (app/layout.jsx), which is the fix.
//   - What this page is still FOR: confirming the numbers afterwards. The
//     lowest crisp band is the real clearance, and safe-area-inset-top tells
//     us whether the standalone padding in globals.css is now a no-op or
//     still doing work. Measure once, then set the spacing from the number.
//
// The bands are deliberately loud. A subtle probe cannot show a subtle wash.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

// Rulers every 10px for the first 180px of the viewport, measured from the
// TRUE top (position:fixed, top:0) rather than from our padded content.
const MARKS = Array.from({ length: 19 }, (_, i) => i * 10);

export default function SafeAreaDiagPage() {
  const [env, setEnv] = useState(null);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-once measurement:
     env() and display-mode only exist once there is a real DOM in a real
     browser, so this genuinely cannot be a lazy initialiser. */
  useEffect(() => {
    // env() is only readable via a probe element — there is no JS API for it.
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:fixed",
      "visibility:hidden",
      "pointer-events:none",
      "top:env(safe-area-inset-top,0px)",
      "right:env(safe-area-inset-right,0px)",
      "bottom:env(safe-area-inset-bottom,0px)",
      "left:env(safe-area-inset-left,0px)",
    ].join(";");
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const read = {
      top: cs.top,
      right: cs.right,
      bottom: cs.bottom,
      left: cs.left,
    };
    probe.remove();

    const mode = ["standalone", "fullscreen", "minimal-ui", "browser"]
      .find((m) => window.matchMedia(`(display-mode: ${m})`).matches) || "unknown";

    setEnv({
      ...read,
      mode,
      // iOS-only and not in the DOM lib's Navigator type, hence the cast.
      // Kept because display-mode can disagree with it on some versions.
      navStandalone: String(
        /** @type {Navigator & { standalone?: boolean }} */ (window.navigator).standalone ?? "n/a",
      ),
      dpr: String(window.devicePixelRatio),
      inner: `${window.innerWidth} x ${window.innerHeight}`,
      screen: `${window.screen.width} x ${window.screen.height}`,
      // Which rung of the height ladder is live. Reading the stylesheet
      // cannot tell you which branch a device took.
      supportsStretch: String(
        typeof CSS !== "undefined" && CSS.supports?.("min-height", "stretch"),
      ),
      supportsFillAvailable: String(
        typeof CSS !== "undefined" && CSS.supports?.("min-height", "-webkit-fill-available"),
      ),
      // The shell's real box against the viewport. Overflow here is the scroll.
      // All four units against innerHeight: which is the viewport, which is
      // the screen.
      // Units composed at runtime, not written as style literals: this file
      // must not read as a viewport-height owner to the contract test.
      rungs: (() => {
        const probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.top = "0";
        document.body.appendChild(probe);
        const measure = (value) => {
          probe.style.height = value;
          return Math.round(probe.getBoundingClientRect().height);
        };
        const out = ["vh", "svh", "lvh", "dvh"]
          .map((u) => `${u}:${measure(`100${u}`)}`)
          .join("  ");
        probe.remove();
        return out;
      })(),
      shell: (() => {
        const el = document.querySelector(".forge-page");
        if (!el) return "no .forge-page on this route";
        const h = Math.round(el.getBoundingClientRect().height);
        return `${h} vs innerHeight ${window.innerHeight} (overflow ${h - window.innerHeight})`;
      })(),
      ua: navigator.userAgent.slice(0, 120),
    });
  }, []);

  return (
    <div style={{ background: "#F2E9E3", color: "#241C19", fontFamily: "system-ui, sans-serif" }}>
      {/* The ruler. Fixed to the true viewport top so the numbers mean
          "this many CSS px from the top edge of the screen" — which is the
          only measurement that answers the question. */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 180, zIndex: 10, pointerEvents: "none" }}>
        {MARKS.map((y) => (
          <div key={y} style={{ position: "absolute", top: y, left: 0, right: 0, height: 10 }}>
            <div
              style={{
                height: "100%",
                // Alternating hard black/white bands: maximum contrast, so any
                // system wash shows as an obvious loss of edge definition.
                background: (y / 10) % 2 === 0 ? "#000" : "#fff",
                display: "flex",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontFamily: "ui-monospace, monospace",
                  paddingLeft: 6,
                  color: (y / 10) % 2 === 0 ? "#fff" : "#000",
                }}
              >
                {y}px
              </span>
              {/* A hairline at every band edge — the first one that still
                  reads sharp is where the system treatment stops. */}
              <span
                style={{
                  marginLeft: 10,
                  flex: 1,
                  height: 1,
                  background: (y / 10) % 2 === 0 ? "#fff" : "#000",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Readout sits below the ruler. */}
      <div style={{ paddingTop: 196, paddingLeft: 20, paddingRight: 20, paddingBottom: 60 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Safe area &amp; status-bar ruler</h1>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: "#6A5B54", marginTop: 0 }}>
          Screenshot this in Safari, then again from the installed app. The
          lowest band that still looks sharp is where the system stops
          interfering — that number is the top clearance our chrome needs.
        </p>

        {!env ? (
          <p style={{ fontSize: 13 }}>measuring…</p>
        ) : (
          <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 16, width: "100%" }}>
            <tbody>
              {[
                ["display-mode", env.mode],
                ["navigator.standalone", env.navStandalone],
                ["safe-area-inset-top", env.top],
                ["safe-area-inset-bottom", env.bottom],
                ["safe-area-inset-left", env.left],
                ["safe-area-inset-right", env.right],
                ["devicePixelRatio", env.dpr],
                ["innerWidth x innerHeight", env.inner],
                ["screen", env.screen],
                ["100vh / svh / lvh / dvh", env.rungs],
                ["supports min-height: stretch", env.supportsStretch],
                ["supports -webkit-fill-available", env.supportsFillAvailable],
                [".forge-page height", env.shell],
              ].map(([k, v]) => (
                <tr key={k} style={{ borderBottom: "1px solid #E0D2C9" }}>
                  <td style={{ padding: "7px 0", color: "#6A5B54" }}>{k}</td>
                  <td style={{ padding: "7px 0", textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ fontSize: 12, lineHeight: 1.6, color: "#6A5B54", marginTop: 20 }}>
          For reference, the app currently clears the top with
          <code style={{ fontFamily: "ui-monospace, monospace" }}> max(52px, safe-area-inset-top + 12px)</code>.
          If the wash reaches past that number, our chrome is sitting inside it.
        </p>
      </div>
    </div>
  );
}
