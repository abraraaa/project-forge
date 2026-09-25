"use client";

// /profile/main-lifts. Same LS-determined first render as /profile, so it
// mounts through the ssr:false shell; no active profile bounces home.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { withNavTransition } from "@/lib/nav-transitions";
import { T, DISPLAY } from "@/lib/tokens";
import { P } from "@/lib/storage";
import { saveMainLiftCore, stashRotationSummary } from "@/lib/profile-actions";
import { isValidMainLiftChoice } from "@/lib/programme";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import ErrorBoundary from "@/components/ErrorBoundary";
import MainLiftEditor from "@/components/MainLiftEditor";

export default function MainLiftsView() {
  const router = useRouter();
  const [current] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [mainLifts, setMainLifts] = useState(() =>
    (typeof window === "undefined" ? {} : P.getMainLifts(P.getActive())));

  useEffect(() => {
    if (!current) router.replace("/");
  }, [current, router]);

  // Validation lives in lib/programme.js so an unlisted movement can never
  // reach the anchor slot, whichever surface calls this.
  const handleChange = (canonical, choice) => {
    if (!current || !isValidMainLiftChoice(canonical, choice)) return;
    // Stamped per lift and synced (see P); re-plans the block's accessories
    // only if the new lift breaks a volume band. Any change shows on home.
    const { mainLifts: next, summary } = saveMainLiftCore(current, canonical, choice);
    setMainLifts(next);
    if (summary) stashRotationSummary(current, summary);
  };

  if (!current) return null;

  return (
    <ErrorBoundary>
      <div style={{background:"transparent",maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px"}}>
        {/* Back, not a push: a pushed /profile leaves this page behind it,
            and Profile's own back then returns here instead of home. */}
        <button type="button"
          onClick={() => withNavTransition(() => {
            if (window.history.length > 1) router.back();
            else router.replace("/profile");
          }, "nav-back")}
          style={{background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink2,display:"inline-flex",alignItems:"center",gap:5,marginBottom:32}}>
          <Glyph name="arrowLeft" size={12} color={T.ink2}/> Profile
        </button>
        <Fade d={0}>
          <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>Training</div>
          <div style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:10}}>Main lifts</div>
          <p style={{fontSize:14,color:T.ink2,marginBottom:28,lineHeight:1.6}}>
            Swap an anchor for an equivalent that loads the same way. Your
            weights carry over and settle after a set or two.
          </p>
        </Fade>
        <Fade d={80}>
          <MainLiftEditor mainLifts={mainLifts} onChange={handleChange} />
        </Fade>
      </div>
    </ErrorBoundary>
  );
}
