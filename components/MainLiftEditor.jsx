"use client";

// The five anchor slots, one chip row each. Options are curated equivalents
// only — an arbitrary movement here silently un-programmes the user.
import { T } from "@/lib/tokens";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, MAIN_LIFT_GROUPS, mainLiftOptions } from "@/lib/programme";

export default function MainLiftEditor({ mainLifts = {}, onChange }) {
  return (
    <div>
      {Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).map((canonical) => {
        const chosen = mainLifts[canonical] || canonical;
        return (
          <div key={canonical} style={{padding:"12px 2px",borderBottom:`1px solid ${T.rule}`}}>
            <div style={{fontSize:12,color:T.ink3,marginBottom:7}}>{MAIN_LIFT_GROUPS[canonical] || canonical}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {mainLiftOptions(canonical).map((opt) => {
                const sel = opt === chosen;
                return (
                  <button key={opt} onClick={()=>onChange(canonical, opt)}
                    aria-pressed={sel}
                    aria-label={opt === canonical ? `${opt}, programme default` : opt}
                    style={{
                      padding:"7px 11px",borderRadius:T.rSm,cursor:"pointer",
                      fontFamily:T.text,fontSize:13,
                      border:"none",
                      background:sel?T.surface:"transparent",
                      boxShadow:sel?T.elev:"none",
                      color:sel?T.ink:T.ink3,
                      transition:`background 180ms ${T.ease}, color 180ms ${T.ease}`,
                    }}>
                    {opt}
                    {opt === canonical && (
                      <span style={{marginLeft:6,fontSize:11,color:T.ink3}}>· Programme</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
