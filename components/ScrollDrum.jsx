"use client";

// components/ScrollDrum.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS-style scroll-snap picker drum, extracted from ForgeApp.jsx during the
// PR3 real-routes migration (stage 3c). Self-contained — React hooks + design
// tokens only; item magnification is CSS view-timeline driven (.drum-item in
// globals.css), so the onScroll handler only commits value changes. Used by
// the bodyweight + weight/reps edit modals. Verbatim, behaviour-preserving.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useRef, useEffect, useCallback } from "react";
import { T } from "@/lib/tokens";

// "settle" beat after a flick stops. Tap-to-jump still works for fine control.
export default function ScrollDrum({value,onChange,step=1.25,min=0,max=500,integer=false,label="",unit=null}){
  const ITEM_H=52,VISIBLE=5,half=Math.floor(VISIBLE/2);
  const values=useMemo(()=>{
    const arr=[];
    if(integer){for(let v=Math.max(min,1);v<=max;v++) arr.push(v);}
    else{const s=Math.round((max-min)/step);for(let i=0;i<=s;i++) arr.push(Math.round((min+i*step)*100)/100);}
    return arr;
  },[min,max,step,integer]);
  const current=parseFloat(value)||0;
  const selectedIdx=Math.max(0,values.findIndex(v=>Math.abs(v-current)<step*0.5));
  const ref=useRef(null);
  const scrolling=useRef(false);
  const timer=useRef(null);
  // Item magnification was a JS-driven onScroll + visibleIdx loop. As of
  // Safari 26 / Chrome 115, CSS view-timeline does the same job natively
  // and silkily — see `.drum-item` in globals.css. The onScroll handler
  // here now only commits the value change (round to nearest snap-line);
  // visual scaling is the compositor's job, not React's.
  useEffect(()=>{
    if(!ref.current||scrolling.current) return;
    const raf=requestAnimationFrame(()=>{ if(ref.current) ref.current.scrollTop=selectedIdx*ITEM_H; });
    return()=>cancelAnimationFrame(raf);
  },[selectedIdx]);
  const onScroll=useCallback(()=>{
    if(!ref.current) return;
    scrolling.current=true;
    const frac=ref.current.scrollTop/ITEM_H;
    const idx=Math.min(Math.round(frac),values.length-1);
    const next=values[Math.max(0,idx)];
    if(next!==undefined&&Math.abs(next-current)>(integer?0.1:0.01)) onChange(next);
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>{scrolling.current=false;},150);
  },[values,current,onChange,integer]);
  const fmt=(v)=>{
    if(integer) return String(Math.round(v));
    const n=Math.round(v*100)/100;
    return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,"").replace(/\.$/,"");
  };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
      {label&&<div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>{label}</div>}
      <div style={{position:"relative",height:ITEM_H*VISIBLE,width:"100%",overflow:"hidden"}}>
        {/* Selected-row band — soft inner shadow + warm tint give the picker
            a "pressed window" depth. Coral lip at top/bottom keeps the focus
            ring while the inner-shadow + rounded corners read as recessed. */}
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:ITEM_H,transform:"translateY(-50%)",background:`${T.coral}18`,borderTop:`1px solid ${T.coral}40`,borderBottom:`1px solid ${T.coral}40`,boxShadow:`inset 0 6px 14px -10px ${T.coral}66, inset 0 -6px 14px -10px ${T.coral}66`,pointerEvents:"none",zIndex:1,borderRadius:T.r.sm}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to bottom,${T.bg2} 24%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to top,${T.bg2} 24%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div ref={ref} onScroll={onScroll} style={{height:"100%",overflowY:"scroll",scrollSnapType:"y mandatory",scrollbarWidth:"none",paddingTop:ITEM_H*half,paddingBottom:ITEM_H*half,boxSizing:"content-box"}}>
          <style>{`*::-webkit-scrollbar{display:none}`}</style>
          {values.map((v,i)=>(
            <div key={i} onClick={()=>onChange(v)} style={{height:ITEM_H,scrollSnapAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
              <span className="drum-item" style={{fontFamily:T.serif,fontSize:30,fontWeight:400,color:T.text1,userSelect:"none"}}>{fmt(v)}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{fontFamily:T.serif,fontSize:12,fontWeight:300,color:T.text3,marginTop:8,fontStyle:"italic"}}>{unit ?? (integer?"reps":"kg")}</div>
    </div>
  );
}
