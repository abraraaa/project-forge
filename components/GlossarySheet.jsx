"use client";

// ─── GlossarySheet ──────────────────────────────────────────────────────────
// Bottom-sheet explainer for the acronyms Forge surfaces (MEV/MAV/MRV, 1RM,
// RPE/RIR, etc.). Lives behind a small ⓘ trigger — most users will never tap
// it, the rest get a one-screen reference without leaving the app.
//
// Add a new term: append to TERMS below. Anchored deep-linking via the
// `anchorTerm` prop scrolls the target term into view on open (used when an
// inline ⓘ next to a specific term opens the sheet pre-positioned).
//
// Same modal/a11y pattern as the other bottom sheets in the app
// (RecentHistorySheet, RotationPreviewSheet) — Escape/backdrop dismisses,
// focus-trap, slideUp animation.

import { useEffect, useRef } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { useModalA11y } from "@/lib/a11y";

// Entries grouped so related terms cluster (MEV/MAV/MRV → one block,
// RPE/RIR → one block). Each entry has a stable `id` used for the anchor.
const TERMS = [
  {
    id: "volume-landmarks",
    title: "MEV · MAV · MRV",
    subtitle: "Weekly volume landmarks",
    body: (
      <>
        <p>Measured in <em>weighted sets per week</em>, per muscle.</p>
        <ul style={{margin:"8px 0 0",padding:"0 0 0 18px",lineHeight:1.6}}>
          <li><strong>MEV</strong> — Minimum Effective Volume. The floor below which a muscle doesn&apos;t accumulate stimulus to grow.</li>
          <li><strong>MAV</strong> — Maximum Adaptive Volume. The productive window — most growth happens between MEV and MAV.</li>
          <li><strong>MRV</strong> — Maximum Recoverable Volume. The ceiling above which extra sets cost more recovery than they earn.</li>
        </ul>
        <p style={{marginTop:8}}>Heatwayve uses Israetel/Helms-derived landmarks, tuned per muscle and per delt head.</p>
      </>
    ),
  },
  {
    id: "1rm",
    title: "1RM",
    subtitle: "Estimated one-rep max",
    body: (
      <>
        <p>The most weight you could move once with good form. Heatwayve estimates it from your logged sets using the Epley formula (weight × (1 + reps / 30)), which is reliable in the 1–10 rep range and gets lossy above 12.</p>
        <p style={{marginTop:8}}>Used as the trend line for each main lift — strength gains show as a rising estimated 1RM over time.</p>
      </>
    ),
  },
  {
    id: "rpe-rir",
    title: "RPE · RIR",
    subtitle: "How hard a set was",
    body: (
      <>
        <p><strong>RPE</strong> — Rate of Perceived Exertion (1–10 scale).</p>
        <p><strong>RIR</strong> — Reps in Reserve (how many more reps you could have done).</p>
        <p style={{marginTop:8}}>Heatwayve collapses both to a three-point scale so you don&apos;t have to do maths between sets:</p>
        <ul style={{margin:"8px 0 0",padding:"0 0 0 18px",lineHeight:1.6}}>
          <li><strong>Easy</strong> — ~3+ reps in reserve. Add weight next time.</li>
          <li><strong>Normal</strong> — ~2 reps in reserve. Working effort. Hold or progress.</li>
          <li><strong>Cooked</strong> — 0–1 reps in reserve. Near failure. Back off next time.</li>
        </ul>
      </>
    ),
  },
  {
    id: "block",
    title: "Block",
    subtitle: "A phase of training",
    body: (
      <>
        <p>A stretch of weeks (typically 6–8) where your accessory exercises stay the same so you can build progression on them. At the end of a block, Heatwayve offers to rotate accessories — fresh stimulus, mainlift progression continues uninterrupted.</p>
      </>
    ),
  },
  {
    id: "rotation",
    title: "Rotation",
    subtitle: "Refreshing the accessory pool",
    body: (
      <>
        <p>Each accessory slot has a pool of equivalent exercises (e.g. Skullcrusher / Overhead Tricep Extension / Close-Grip Push-Up). Rotation picks a fresh one weighted by your training focus, avoiding the last few weeks&apos; selections. Main lifts never rotate — they live and die by progressive overload.</p>
      </>
    ),
  },
  {
    id: "superset",
    title: "Superset",
    subtitle: "Two exercises back-to-back",
    body: (
      <>
        <p>Two exercises (typically targeting different muscle groups) performed one after the other with minimal rest, then rested as a pair. Heatwayve writes them as A ↔ B. Each round counts as one set of each. Saves time and adds a cardio nudge.</p>
      </>
    ),
  },
  {
    id: "tonnage",
    title: "Tonnage",
    subtitle: "Total weight moved",
    body: (
      <>
        <p>Sum of (weight × reps) across every set. Dumbbell sets count both arms (per-DB weight × 2). It&apos;s a vanity metric — useful for milestone moments, not for programming decisions (use sets/week vs MEV/MAV/MRV for that).</p>
      </>
    ),
  },
];

export default function GlossarySheet({ anchorTerm = null, onCancel }) {
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "glossary-title";
  const scrollRef = useRef(null);

  // Anchor: on open, scroll the target term to the top of the scroll area.
  useEffect(() => {
    if (!anchorTerm || !scrollRef.current) return;
    const node = scrollRef.current.querySelector(`[data-term-id="${anchorTerm}"]`);
    if (node) node.scrollIntoView({ block: "start", behavior: "auto" });
  }, [anchorTerm]);

  return (
    <div onKeyDown={onKeyDown} onClick={onCancel}
      className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px 32px",width:"100%",animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
          Glossary
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:14}}>
          The terms Heatwayve uses
        </div>

        <div ref={scrollRef} style={{flex:1,overflowY:"auto",marginRight:-8,paddingRight:8}}>
          {TERMS.map((t, i) => (
            <div key={t.id} data-term-id={t.id}
              style={{padding:"14px 0",borderBottom:i<TERMS.length-1?`1px solid ${T.ruleFaint}`:"none"}}>
              <div style={{fontSize:16,fontWeight:600,color:T.ink,marginBottom:2}}>{t.title}</div>
              <div style={{fontSize:12,color:T.ink3,marginBottom:8}}>{t.subtitle}</div>
              <div style={{fontSize:13,color:T.ink2,lineHeight:1.55,fontFamily:T.text}}>{t.body}</div>
            </div>
          ))}
        </div>

        <button onClick={onCancel}
          style={{marginTop:14,padding:"12px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:13,color:T.ink2,fontFamily:T.text}}>
          Close
        </button>
      </div>
    </div>
  );
}

// Small inline trigger — renders the ⓘ glyph styled to feel ambient. Use
// inside text where a term first appears (or in card subtitles), passing the
// term id to anchor the sheet on open.
export function GlossaryTrigger({ anchorTerm = null, onOpen, label = "Open glossary" }) {
  return (
    // 18px RING, 32px TARGET. The ring is what the eye sees and must not
    // change; the button around it is a transparent 32x32 hit area so the
    // control clears the WCAG 2.5.8 minimum (24x24). Negative margins absorb
    // the extra box in both axes, so inline text rhythm and the 6px gap from
    // the preceding word are exactly as before — this is a touch fix, not a
    // visual one.
    <button onClick={(e) => { e.stopPropagation(); onOpen(anchorTerm); }} aria-label={label}
      style={{
        display:"inline-flex",alignItems:"center",justifyContent:"center",
        width:32,height:32,margin:"-7px -7px -7px -1px",padding:0,
        boxSizing:"border-box",
        background:"none",border:"none",
        cursor:"pointer",
        lineHeight:1,verticalAlign:"middle",
      }}>
      <span aria-hidden="true" style={{
        display:"inline-flex",alignItems:"center",justifyContent:"center",
        width:18,height:18,boxSizing:"border-box",
        border:`1px solid ${T.rule}`,borderRadius:"50%",
        fontFamily:T.text,fontSize:11,fontWeight:500,color:T.ink3,
        lineHeight:1,
      }}>i</span>
    </button>
  );
}
