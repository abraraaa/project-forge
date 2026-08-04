"use client";
// components/InstallWalkthrough.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The "Add to Home Screen" walkthrough — Safari on iOS has no
// beforeinstallprompt, so we walk the user through the native flow ourselves.
// Extracted from ForgeApp so it serves two callers:
//   · ForgeApp's one-shot nudge (after first completed session, dismissable,
//     remembered via localStorage — including the migration voice, dormant
//     until heatwayve.app is primary: three gates, boss catches 2026-07-27)
//   · the Profile row, where a user who tapped "Maybe later" once can find
//     the steps again on purpose. The nudge fires once; the route is forever.
// `migration`: the re-add moment for MIGRATED users only — new origin AND
// inside the 60-day window AND a pre-flip story in history. First-timers get
// the ordinary pitch (you can't add something BACK you never had).
// `cta`: bottom-row label. The nudge says "Maybe later" (it interrupted);
// the Profile row says "Close" (the user asked).
// ─────────────────────────────────────────────────────────────────────────────

import { T, DISPLAY } from "@/lib/tokens";
import { useModalA11y } from "@/lib/a11y";

export default function InstallWalkthrough({ onDismiss, migration = false, cta = "Maybe later" }) {
  const { containerRef, onKeyDown } = useModalA11y(onDismiss);
  const titleId = "ios-install-title";
  return (
    <div
      onClick={onDismiss}
      onKeyDown={onKeyDown}
      className="forge-scrim forge-scrim-plain" style={{
        zIndex:500,
        overscrollBehavior:"contain",
        display:"flex",alignItems:"flex-end",justifyContent:"center",
        animation:`fadeIn 220ms ${T.ease}`,
      }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e => e.stopPropagation()}
        className="forge-vellum"
        style={{
          borderRadius:"12px 12px 0 0",
          outline:"none",
          padding:"24px 24px calc(24px + env(safe-area-inset-bottom))",
          width:"100%",maxWidth:430,
          maxHeight:"92vh",overflowY:"auto",
          animation:`slideUp 280ms ${T.ease}`,
          position:"relative",
          boxSizing:"border-box",
        }}>
        {/* No corner ✕ — house modal doctrine (bottom-row dismiss only). */}
        <div style={{fontSize:13,fontWeight:500,color:T.ink3,marginBottom:8}}>
          {migration ? "Same fire, new home" : "Live on your home screen"}
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:10}}>
          Heatwayve
        </div>
        <p style={{fontSize:13,color:T.ink2,marginBottom:20,lineHeight:1.6}}>
          {migration
            ? "Add it back — we moved, and your story came with us. One re-add and the home screen is yours again."
            : "Install it: fullscreen, one tap to open, works offline between sessions."}
        </p>

        {/* Three steps — Safari's share flow */}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <InstallStep n="1">
            <span style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              Tap the share icon <ShareGlyph/>
            </span>
          </InstallStep>
          <InstallStep n="2">
            <span>Scroll and pick <span style={{color:T.ink,fontWeight:500}}>Add to Home Screen</span></span>
          </InstallStep>
          <InstallStep n="3">
            <span>Tap <span style={{color:T.ink,fontWeight:500}}>Add</span> — done</span>
          </InstallStep>
        </div>

        <button onClick={onDismiss}
          style={{width:"100%",padding:"14px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:14,color:T.ink2}}>
          {cta}
        </button>
      </div>
    </div>
  );
}

// True on an iOS browser that is NOT already running from the home screen —
// the only audience the walkthrough serves. Callers gate their entry point on
// this so Android (native manifest prompt) and installed users never see it.
export function canWalkthroughInstall() {
  if (typeof window === "undefined") return false;
  const isIOS = /iPad|iPhone|iPod/.test(window.navigator.userAgent)
    && !(/** @type {any} */ (window)).MSStream;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || (/** @type {any} */ (window.navigator)).standalone === true;
  return isIOS && !isStandalone;
}

// SVG glyph approximating the iOS Safari share icon — a square with an
// up-arrow emerging from the top. Inline with the text, ink stroke: the
// glyph grammar is round caps and open strokes, no filled shapes.
function ShareGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="18" height="22" viewBox="0 0 18 22"
      style={{display:"inline-block",verticalAlign:"-5px",flexShrink:0}}
    >
      {/* Box — lower two thirds */}
      <rect x="2" y="8" width="14" height="12" rx="2" ry="2"
        fill="none" stroke="var(--ink-2)" strokeWidth="2.25"/>
      {/* Arrow shaft */}
      <line x1="9" y1="2" x2="9" y2="13"
        stroke="var(--ink-2)" strokeWidth="2.25" strokeLinecap="round"/>
      {/* Arrow head */}
      <polyline points="5,6 9,2 13,6"
        fill="none" stroke="var(--ink-2)" strokeWidth="2.25"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// Enclosure is not in the drawn-glyph grammar — the step number stands as
// a bare mono numeral against a hairline, same language as the data marks.
function InstallStep({ n, children }) {
  return (
    <div style={{display:"flex",alignItems:"baseline",gap:14,paddingBottom:10,borderBottom:`1px solid ${T.ruleFaint}`}}>
      <div style={{flexShrink:0,width:16,fontFamily:T.measured,fontSize:14,color:T.ink3}}>{n}</div>
      <div style={{flex:1,fontSize:14,color:T.ink2,lineHeight:1.5}}>
        {children}
      </div>
    </div>
  );
}
