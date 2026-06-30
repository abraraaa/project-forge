"use client";

// components/BodyweightEditModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Bottom-sheet modal for editing bodyweight, extracted from ForgeApp.jsx
// during the PR3 real-routes migration (stage 3c). Deps are all importable
// modules (ScrollDrum, useModalA11y, tokens) — no app state, no auth — so it
// moves cleanly. `slideUp` is a CSS keyframe in globals.css. Verbatim,
// behaviour-preserving.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useModalA11y } from "@/lib/a11y";
import { T } from "@/lib/tokens";
import ScrollDrum from "@/components/ScrollDrum";

// Reusable bottom-sheet modal for editing bodyweight. Triggered from:
// - Home screen BW re-prompt card
// - Profile settings BW row
// - Post-session BW prompt after logging bodyweight movements
export default function BodyweightEditModal({open,onClose,currentKg,onSave}){
  const [kg,setKg]=useState(currentKg || 75);

  // Reset the input to the latest value each time the modal opens. Done as a
  // render-phase adjustment (tracking the previous `open`) rather than an
  // effect — React applies the setState before paint, no extra render, and it
  // sidesteps the cascading-render trap of syncing props to state in an effect.
  const [wasOpen,setWasOpen]=useState(open);
  if(open!==wasOpen){
    setWasOpen(open);
    if(open) setKg(currentKg || 75);
  }

  if(!open) return null;

  // First-time entry vs update — first time gets a one-line context, updates
  // get the tighter "Scroll to adjust" subtitle that mirrors DrumEditOverlay.
  // Same editorial family, different density to match the moment.
  const isFirstTime = currentKg === null || currentKg === undefined;

  return <BodyweightEditModalInner kg={kg} setKg={setKg} onClose={onClose} onSave={onSave} isFirstTime={isFirstTime}/>;
}

function BodyweightEditModalInner({kg, setKg, onClose, onSave, isFirstTime}){
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "bw-edit-title";
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.82)",backdropFilter:"blur(7px) saturate(115%)",WebkitBackdropFilter:"blur(7px) saturate(115%)",overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.sage}28`,animation:`slideUp 260ms ${T.ease}`,outline:"none"}}>

        {/* Header — tightened to match DrumEditOverlay pattern. ✕ close
            sits top-right rather than a separate Cancel button at the bottom. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div>
            <div id={titleId} style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>Bodyweight</div>
            <div style={{fontSize:12,color:T.text3,marginTop:4,lineHeight:1.5,maxWidth:280}}>
              {isFirstTime
                ? "Used for loaded pull-ups, dips, and other weighted bodyweight movements."
                : "Scroll to adjust"}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13,flexShrink:0}}>✕</button>
        </div>

        <div style={{display:"flex",justifyContent:"center",marginBottom:24}}>
          <ScrollDrum value={kg} onChange={setKg} step={0.5} min={40} max={200} unit="kg"/>
        </div>

        {/* Single sage CTA — semantically aligned (BW is a passive measurement,
            not a training action; coral is reserved for training-action surfaces). */}
        <button onClick={()=>{onSave(kg);onClose();}} style={{width:"100%",padding:"16px",background:T.sage,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.sage}26`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>Confirm</span>
          <span style={{fontSize:16}}>→</span>
        </button>
      </div>
    </div>
  );
}
