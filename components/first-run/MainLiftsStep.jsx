"use client";

// components/first-run/MainLiftsStep.jsx
// First-run main lifts. One row per slot; Change opens that slot's curated
// equivalents (the same list MainLiftEditor offers). Presentational: the
// parent saves on onChange, which only fires for a different lift.
import { useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, MAIN_LIFT_GROUPS, mainLiftOptions } from "@/lib/programme";

const SLOTS = Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS);

export default function MainLiftsStep({ mainLifts = {}, onChange, onNext }) {
  const [open, setOpen] = useState(/** @type {string|null} */ (null));
  const pick = (slot, chosen, opt) => {
    setOpen(null);
    if (opt === chosen) return;
    haptic.toggle();
    onChange(slot, opt);
  };
  return (
    <div style={{maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",display:"flex",flexDirection:"column"}}>
      <Fade d={0}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:18}}>Training</div>
        <div style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:16}}>Main lifts</div>
      </Fade>
      <Fade d={80}>
        <p style={{fontSize:14,color:T.ink2,lineHeight:1.6,marginBottom:12}}>
          Five lifts carry your progression. They stay put while everything around them rotates, so your numbers mean something week to week.
        </p>
        <p style={{fontSize:14,color:T.ink2,lineHeight:1.6,marginBottom:20}}>
          Here&apos;s what we suggest. Change one only with a reason: an injury, or the kit you have.
        </p>
      </Fade>
      <Fade d={140}>
        <div style={{marginBottom:32}}>
          {SLOTS.map((slot) => {
            const chosen = mainLifts?.[slot] || slot;
            const isOpen = open === slot;
            const listId = `first-run-lift-${slot.replace(/\W+/g, "-")}`;
            return (
              <div key={slot} style={{padding:"12px 2px",borderBottom:`1px solid ${T.rule}`}}>
                <div style={{fontSize:12,color:T.ink3,marginBottom:4}}>{MAIN_LIFT_GROUPS[slot] || slot}</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                  <span style={{fontSize:16,color:T.ink}}>{chosen}</span>
                  <button type="button" onClick={() => { haptic.tap(); setOpen(isOpen ? null : slot); }}
                    aria-expanded={isOpen} aria-controls={listId} aria-label={`${isOpen ? "Done" : "Change"} ${MAIN_LIFT_GROUPS[slot] || slot}`}
                    style={{padding:"6px 2px",background:"none",border:"none",cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink2,display:"inline-flex",alignItems:"center",gap:5}}>
                    {isOpen ? "Done" : "Change"}
                    <Glyph name={isOpen ? "chevronUp" : "chevronDown"} size={11} color={T.ink3}/>
                  </button>
                </div>
                {isOpen && (
                  <div id={listId} style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10}}>
                    {mainLiftOptions(slot).map((opt) => {
                      const sel = opt === chosen;
                      return (
                        <button key={opt} type="button" onClick={() => pick(slot, chosen, opt)}
                          aria-pressed={sel}
                          aria-label={opt === slot ? `${opt}, programme default` : opt}
                          style={{padding:"7px 11px",borderRadius:T.rSm,cursor:"pointer",fontFamily:T.text,fontSize:13,border:"none",background:sel?T.surface:"transparent",boxShadow:sel?T.elev:"none",color:sel?T.ink:T.ink3,transition:`background 180ms ${T.ease}, color 180ms ${T.ease}`}}>
                          {opt}
                          {opt === slot && <span style={{marginLeft:6,fontSize:11,color:T.ink3}}>· Programme</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Fade>
      <Fade d={200}>
        <button type="button" className="forge-press" onClick={onNext}
          style={{width:"100%",height:58,padding:"0 22px",background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>Keep these</span>
          <Glyph name="arrowRight" size={14}/>
        </button>
      </Fade>
    </div>
  );
}
