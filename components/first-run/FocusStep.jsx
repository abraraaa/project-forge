"use client";

// components/first-run/FocusStep.jsx
// First-run focus. Presentational: the parent saves on onChange (only a real
// change reaches it) and moves on with onNext. Keep writes nothing.
import { T, DISPLAY } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { FOCUS_OPTIONS, FOCUS_SUMMARIES, DEFAULT_FOCUS } from "@/lib/programme";

export default function FocusStep({ value, onChange, onNext }) {
  const current = FOCUS_OPTIONS.includes(value) ? value : DEFAULT_FOCUS;
  const pick = (f) => {
    if (f === current) return;
    haptic.toggle();
    onChange(f);
  };
  return (
    <div style={{maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",display:"flex",flexDirection:"column"}}>
      <Fade d={0}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:18}}>Training</div>
        <div style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:16}}>Focus</div>
      </Fade>
      <Fade d={80}>
        <p style={{fontSize:14,color:T.ink2,lineHeight:1.6,marginBottom:24}}>
          Shapes the accessories around your main lifts. Change it any time in Profile.
        </p>
      </Fade>
      <Fade d={140}>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:32}}>
          {FOCUS_OPTIONS.map((f) => {
            const active = f === current;
            return (
              <button key={f} type="button" onClick={() => pick(f)} aria-pressed={active}
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
      </Fade>
      <Fade d={200}>
        <button type="button" className="forge-press" onClick={onNext}
          style={{width:"100%",height:58,padding:"0 22px",background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:17,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>Keep {current}</span>
          <Glyph name="arrowRight" size={14}/>
        </button>
      </Fade>
    </div>
  );
}
