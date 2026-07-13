"use client";

// components/FocusPickerSheet.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Training-focus picker bottom sheet, extracted from ForgeApp.jsx during the
// PR3 real-routes migration (3d-route) so both hosts — ForgeApp's in-place
// paths and the /profile route — render one implementation. Presentational:
// {current, onSave, onCancel}; the save-side effects (F/PB persistence +
// re-rotation) live in lib/profile-actions.js#saveFocusCore. Verbatim move.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useModalA11y, haptic } from "@/lib/a11y";
import { T } from "@/lib/tokens";
import { FOCUS_OPTIONS, FOCUS_SUMMARIES, DEFAULT_FOCUS } from "@/lib/programme";

// pill to preview its summary, then Save to apply. Save triggers an immediate
// re-rotation with the new bias — the rotation-summary modal that follows
// shows the user exactly what shifted in their accessories.
export default function FocusPickerSheet({ current, onSave, onCancel }) {
  const [draft, setDraft] = useState(current || DEFAULT_FOCUS);
  const { containerRef, onKeyDown } = useModalA11y(onCancel);
  const titleId = "focus-picker-title";
  const changed = draft !== current;
  return (
    <div onKeyDown={onKeyDown} onClick={onCancel} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()}
        className="forge-sheet-ground" style={{background:T.bg2,padding:"28px 24px 32px",width:"100%",borderTop:`1px solid ${T.bg3}`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"90vh",display:"flex",flexDirection:"column",outline:"none"}}>
        <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          Training focus
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.15,marginBottom:6,color:T.text1}}>
          What are you training for?
        </div>
        <p style={{fontSize:13,color:T.text3,marginBottom:18,lineHeight:1.5}}>
          Every focus trains your whole body. A focus sets the <em>shape</em> of your week — where each muscle sits in its training band — and rotation solves for it. Main lifts never change.
        </p>

        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          {FOCUS_OPTIONS.map(f => {
            const active = draft === f;
            return (
              <button key={f} onClick={()=>{haptic.toggle();setDraft(f);}}
                aria-pressed={active}
                style={{padding:"14px 16px",background:active?`${T.gold}14`:T.bg3,border:`1px solid ${active?T.gold:T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"left",transition:`all 160ms ${T.ease}`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:active?T.gold:T.text1,fontStyle:active?"italic":"normal"}}>{f}</span>
                  {active && <span style={{fontSize:13,color:T.gold}}>✓</span>}
                </div>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>{FOCUS_SUMMARIES[f]}</div>
              </button>
            );
          })}
        </div>

        {changed && (
          <div style={{marginBottom:14,padding:"10px 12px",background:`${T.gold}10`,border:`1px solid ${T.gold}33`,borderRadius:T.r.sm,fontSize:12,color:T.text2,lineHeight:1.5}}>
            Saving will re-rotate your accessories now to reflect the new focus.
          </div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button onClick={onCancel}
            style={{flex:1,padding:"14px",background:"none",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",fontSize:13,color:T.text2,fontFamily:T.sans}}>
            Cancel
          </button>
          {/* Coral, not gold — gold is the focus DOMAIN tint (pills, rim,
              notice); actions are consistently coral across the app. */}
          <button onClick={()=>onSave(draft)} disabled={!changed}
            style={{flex:2,padding:"14px",background:changed?T.coral:T.bg3,border:"none",borderRadius:T.r.lg,cursor:changed?"pointer":"default",fontFamily:T.serif,fontSize:16,fontWeight:400,color:changed?T.bg0:T.text3,opacity:changed?1:0.6}}>
            Save focus
          </button>
        </div>
      </div>
    </div>
  );
}
