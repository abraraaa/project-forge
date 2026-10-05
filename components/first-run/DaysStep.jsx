"use client";

// components/first-run/DaysStep.jsx
// First-run strength days. Toggling a day rebuilds the week from the one the
// step opened with (moveStrengthDays), so a moved strength day hands its
// conditioning type over instead of losing it, and toggling back restores
// that week unchanged. Presentational: never touches W.
import { useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { haptic } from "@/lib/a11y";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { projectStrengthDaySessions } from "@/lib/programme";
import { mondayIndex } from "@/lib/dates";
import { useTodayIso } from "@/lib/use-today-iso";
import { moveStrengthDays, dayNote, strengthDayCount } from "@/lib/first-run";

const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LETTERS = ["A", "B", "C"];

// todayIdx is for tests and screenshots; the app leaves it to the clock.
export default function DaysStep({ week, onChange, onNext, todayIdx }) {
  const [base] = useState(week);
  const todayIso = useTodayIso();
  const today = todayIdx ?? mondayIndex(todayIso) ?? 0;
  // No history yet, so the first strength day from today on is A.
  const letters = projectStrengthDaySessions(week, [], today);
  const count = strengthDayCount(week);
  const note = dayNote(count);

  const toggle = (i) => {
    const chosen = week.map((d, j) => (d.type === "strength" ? j : -1)).filter((j) => j >= 0);
    const next = chosen.includes(i) ? chosen.filter((j) => j !== i) : [...chosen, i];
    haptic.toggle();
    onChange(moveStrengthDays(base, next));
  };

  return (
    <div style={{maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",display:"flex",flexDirection:"column"}}>
      <Fade d={0}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:18}}>Your week</div>
        <div style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:16}}>Strength days</div>
      </Fade>
      <Fade d={80}>
        <p style={{fontSize:14,color:T.ink2,lineHeight:1.6,marginBottom:24}}>
          Pick your days. A, B and C follow in order, whichever days you choose.
        </p>
      </Fade>
      <Fade d={140}>
        <div role="group" aria-label="Strength days" style={{display:"flex",gap:6,marginBottom:14}}>
          {week.map((d, i) => {
            const on = d.type === "strength";
            const letter = on ? LETTERS[letters[i]] : null;
            return (
              <button key={i} type="button" onClick={() => toggle(i)} aria-pressed={on}
                aria-label={on ? `${LONG[i]}, Strength ${letter}` : `${LONG[i]}, ${d.label || d.type}`}
                style={{flex:1,minWidth:0,height:68,padding:"10px 0 8px",background:on?T.surface:"transparent",border:`1px solid ${on?"transparent":T.rule}`,boxShadow:on?T.elev:"none",borderRadius:T.rSm,cursor:"pointer",fontFamily:T.text,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"space-between",transition:`background 160ms ${T.ease}`}}>
                <span style={{fontSize:12,fontWeight:on?600:400,color:on?T.ink:T.ink3}}>{SHORT[i]}</span>
                {on
                  ? <span data-letter style={{...DISPLAY,fontSize:22,color:T.ink}}>{letter}</span>
                  : <span aria-hidden="true" style={{width:14,height:3,marginBottom:8,background:T.dayKey[d.type] || T.dayKey.rest,opacity:0.4}}/>}
              </button>
            );
          })}
        </div>
        <p style={{fontSize:13,color:T.ink3,lineHeight:1.5,marginBottom:16}}>
          Other days keep their conditioning plan. Edit week on Home changes those.
        </p>
        {note && (
          <div role="status" style={{padding:"10px 12px",background:T.surface,boxShadow:T.elev,borderRadius:T.r,fontSize:13,color:T.ink2,lineHeight:1.5,marginBottom:16}}>
            {note}
          </div>
        )}
      </Fade>
      <Fade d={200}>
        <button type="button" className="forge-press" onClick={onNext} disabled={count === 0}
          style={{width:"100%",height:58,marginTop:16,padding:"0 22px",background:count?T.commit:T.well,border:"none",borderRadius:T.r,cursor:count?"pointer":"default",fontFamily:T.text,fontSize:17,fontWeight:500,color:count?T.commitInk:T.ink3,boxShadow:count?T.elevStrong:"none",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>{count ? `Keep ${count} day${count === 1 ? "" : "s"}` : "Pick a day"}</span>
          {count > 0 && <Glyph name="arrowRight" size={14}/>}
        </button>
      </Fade>
    </div>
  );
}
