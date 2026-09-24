"use client";

// /profile/coach — AI coaching. Connecting an AI is coming; handing it a
// snapshot works today.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { T, DISPLAY } from "@/lib/tokens";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import ErrorBoundary from "@/components/ErrorBoundary";
import { P } from "@/lib/storage";
import { withNavTransition } from "@/lib/nav-transitions";
import { copyCoachContext } from "@/lib/coach-share";

export default function CoachView() {
  const router = useRouter();
  const [current] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    if (!current) router.replace("/");
  }, [current, router]);
  if (!current) return null;

  const onCopy = async () => setCopied(await copyCoachContext(current));

  return (
    <ErrorBoundary>
      <div style={{background:"transparent",maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px"}}>
        <button type="button"
          onClick={() => withNavTransition(() => {
            if (window.history.length > 1) router.back();
            else router.replace("/profile");
          }, "nav-back")}
          style={{background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink2,display:"inline-flex",alignItems:"center",gap:5,marginBottom:32}}>
          <Glyph name="arrowLeft" size={12} color={T.ink2}/> Profile
        </button>
        <Fade d={0}>
          <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>AI coaching</div>
          <h1 style={{...DISPLAY,fontSize:38,color:T.ink,margin:"0 0 10px"}}>Talk it through</h1>
          <p style={{fontSize:14,color:T.ink2,marginBottom:32,lineHeight:1.6}}>Your numbers, your AI, one conversation.</p>
        </Fade>

        <Fade d={80}>
          <div style={{padding:"15px 2px",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:15,fontWeight:500,color:T.ink3}}>Connect your AI</span>
              <span style={{fontSize:11,color:T.ink3,border:`1px solid ${T.rule}`,borderRadius:T.rSm,padding:"1px 6px"}}>Soon</span>
            </div>
            <div style={{fontSize:12,color:T.ink3,marginTop:4,lineHeight:1.5}}>
              Grok, ChatGPT or Claude reads your training as it happens. One tap, Face ID, in.
            </div>
          </div>
        </Fade>

        <Fade d={140}>
          <div style={{padding:"18px 2px",borderBottom:`1px solid ${T.rule}`}}>
            <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Hand it the story</div>
            <div style={{fontSize:12,color:T.ink3,marginTop:4,lineHeight:1.5,marginBottom:14}}>
              Lifts, volume, rhythm — in one copy. A snapshot: it sees today, not tomorrow.
            </div>
            <button type="button" onClick={onCopy} className="forge-press forge-lift"
              style={{width:"100%",height:52,background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:15,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong}}>
              {copied === "ok" ? "Copied" : "Copy your training"}
            </button>
            <div role="status" aria-live="polite" style={{fontSize:12,color:T.ink3,marginTop:10,minHeight:16}}>
              {copied === "ok" ? "Paste it into any chat." : copied === "fail" ? "Couldn't reach the clipboard — try again." : ""}
            </div>
          </div>
        </Fade>
      </div>
    </ErrorBoundary>
  );
}
