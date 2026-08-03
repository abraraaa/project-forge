"use client";

// components/FocusPickerSheet.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Training-focus picker bottom sheet — Bone & Ember. Presentational:
// {current, onSave, onCancel}; the save-side effects (F/PB persistence +
// re-rotation) live in lib/profile-actions.js#saveFocusCore.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useModalA11y, haptic } from "@/lib/a11y";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";
import { FOCUS_OPTIONS, FOCUS_SUMMARIES, DEFAULT_FOCUS } from "@/lib/programme";

// Tap a focus to preview its summary, then Save to apply. Save triggers an
// immediate re-rotation with the new bias — the rotation-summary modal that
// follows shows the user exactly what shifted in their accessories.
export default function FocusPickerSheet({ current, onSave, onCancel }) {
  const [draft, setDraft] = useState(current || DEFAULT_FOCUS);
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "focus-picker-title";
  const changed = draft !== current;
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px 32px",width:"100%",animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:8}}>
          Training focus
        </div>
        <div id={titleId} style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:8}}>
          Focus
        </div>
        <p style={{fontSize:13,color:T.ink2,marginBottom:16,lineHeight:1.5}}>
          What are you training for? Every focus trains your whole body. A focus sets the <em>shape</em> of your week: where each muscle sits in its training band. Rotation solves for it. Main lifts never change.
        </p>

        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          {FOCUS_OPTIONS.map(f => {
            const active = draft === f;
            return (
              <button key={f} onClick={()=>{haptic.toggle();setDraft(f);}}
                aria-pressed={active}
                style={{padding:"14px 16px",background:active?T.surface:"transparent",border:`1px solid ${active?"transparent":T.rule}`,boxShadow:active?T.elev:"none",borderRadius:T.r,cursor:"pointer",textAlign:"left",fontFamily:T.text,transition:`background 160ms ${T.ease}`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:16,fontWeight:active?600:500,color:T.ink}}>{f}</span>
                  {active && <Glyph name="check" size={12} color={T.ink2}/>}
                </div>
                <div style={{fontSize:13,color:T.ink2,lineHeight:1.5}}>{FOCUS_SUMMARIES[f]}</div>
              </button>
            );
          })}
        </div>

        {changed && (
          <div style={{marginBottom:14,padding:"10px 12px",background:T.surface,boxShadow:T.elev,borderRadius:T.r,fontSize:13,color:T.ink2,lineHeight:1.5}}>
            Saving will re-rotate your accessories now to reflect the new focus.
          </div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onCancel}
            style={{flex:1,padding:"14px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontSize:13,color:T.ink2,fontFamily:T.text}}>
            Cancel
          </button>
          <button onClick={()=>onSave(draft)} disabled={!changed}
            style={{flex:2,padding:"14px",background:changed?T.commit:T.well,border:"none",borderRadius:T.r,cursor:changed?"pointer":"default",fontFamily:T.text,fontSize:15,fontWeight:500,color:changed?T.commitInk:T.ink3,boxShadow:changed?T.elevStrong:"none"}}>
            Save focus
          </button>
        </div>
      </div>
    </div>
  );
}
