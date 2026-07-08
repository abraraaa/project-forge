"use client";

// components/ProfileScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The identity gate + profile settings surface, extracted verbatim from
// ForgeApp.jsx during the PR3 real-routes migration (stage 3d-prep). Still
// rendered by ForgeApp exactly as before (when !activeProfile, or on
// profile-switch) — this is pure decomposition, no routing change. All
// activation logic stays in ForgeApp and arrives via the onActivate prop;
// see docs/decomposition-map.md for the 3d-route design call that would
// change that.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import { T } from "@/lib/tokens";
import { LS, P, BW, blobDelete, checkProfileExists } from "@/lib/storage";
import {
  hasPasskey, registerPasskey, authenticatePasskey, isPlatformAuthenticatorAvailable,
} from "@/lib/webauthn";
import { FOCUS_SUMMARIES } from "@/lib/programme";
import { reasonLabel } from "@/lib/breaks";
import { Fade } from "@/components/ui";
import { SyncStatusCard, SyncNowRow } from "@/components/sync-cards";
import ScrollDrum from "@/components/ScrollDrum";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import TakenNameModal from "@/components/TakenNameModal";

export default function ProfileScreen({existing,current,onActivate,onCancel,bodyweight=null,bwEditOpen=false,setBwEditOpen,updateBodyweight,userFocus="Forged",onEditFocus,onOpenBreather,resting=false,restingReason=null,onEndBreather}){
  const [name,setName]=useState("");
  const [confirmWipe,setConfirmWipe]=useState(null);
  const [showTakenHelp,setShowTakenHelp]=useState(false);
  // availability: "idle" | "checking" | "available" | "taken" | "network-err"
  const [availability,setAvailability]=useState("idle");
  const [submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState(null);
  const checkTimerRef = useRef(null);
  const latestQueryRef = useRef("");
  const {strength:s}=T;

  // Post-claim BW step (only for new users with no existing profiles)
  const [showBwStep, setShowBwStep] = useState(false);
  const [pendingBw, setPendingBw] = useState(75);
  const [claimedName, setClaimedName] = useState(null);

  // Onboarding passkey step — sits between name claim and BW step.
  // Only renders if WebAuthn is supported (capability gate). Skipping or
  // failing the ceremony falls through to the BW step — onboarding never
  // breaks. The flag is one-shot; once dismissed (accept or skip), we move on.
  const [showPasskeyStep, setShowPasskeyStep] = useState(false);
  const [onboardingPasskeyBusy, setOnboardingPasskeyBusy] = useState(false);
  const [onboardingPasskeyError, setOnboardingPasskeyError] = useState(null);

  // Passkey state
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState(null);
  const [profileHasPasskey, setProfileHasPasskey] = useState({});
  const [authToken, setAuthToken] = useState(null); // For authenticated destructive ops
  const [needsPasskeyAuth, setNeedsPasskeyAuth] = useState(null); // Profile name requiring auth

  // Check WebAuthn support on mount
  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setWebAuthnSupported);
  }, []);

  // Check if each profile has a passkey (only on mount, not when state changes)
  // Using a ref to track which profiles we've already checked
  const checkedProfilesRef = useRef(new Set());
  useEffect(() => {
    // Check all existing profiles we haven't checked yet
    existing.forEach(async (profile) => {
      if (checkedProfilesRef.current.has(profile)) return;
      checkedProfilesRef.current.add(profile);
      const has = await hasPasskey(profile);
      // Only update if not already true (preserves local registration state)
      setProfileHasPasskey(prev => prev[profile] === true ? prev : { ...prev, [profile]: has });
    });
    // Also explicitly check current profile if not checked
    if (current && !checkedProfilesRef.current.has(current)) {
      checkedProfilesRef.current.add(current);
      hasPasskey(current).then(has => {
        setProfileHasPasskey(prev => prev[current] === true ? prev : { ...prev, [current]: has });
      });
    }
  }, [existing, current]);

  // Expanded wipe: opts.cloud === true also nukes cloud data via DELETE /api/sync.
  // opts.cloud === false only clears local storage (fast, offline-safe).
  const [wipeBusy,setWipeBusy]=useState(false);
  const [wipeError,setWipeError]=useState(null);
  const wipeProfile=async (n,{cloud=false}={})=>{
    setWipeError(null);
    setWipeBusy(true);
    if (cloud) {
      const result = await blobDelete(n, { authToken });
      if (!result.ok) {
        setWipeBusy(false);
        if (result.requiresAuth) {
          setConfirmWipe(null);
          setNeedsPasskeyAuth(n);
          return;
        }
        setWipeError(result.error || "Couldn't reach the cloud. Try again?");
        return;
      }
    }
    // Local cleanup always runs regardless of cloud branch
    ["weights","reps","streak","history","pendingPushes"].forEach(k=>localStorage.removeItem(`forge:${n}:${k}`));
    const updated=P.list().filter(p=>p!==n);
    LS.set("forge:profiles",updated);
    if(P.getActive()===n){ LS.set("forge:active",null); }
    setWipeBusy(false);
    setConfirmWipe(null);
    setAuthToken(null);
    window.location.reload();
  };

  // Handle passkey authentication for destructive ops
  const handlePasskeyAuth = async () => {
    if (!needsPasskeyAuth) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(needsPasskeyAuth);
      if (result?.verified && result?.authToken) {
        setAuthToken(result.authToken);
        setNeedsPasskeyAuth(null);
        // Now retry the wipe with the token
        setConfirmWipe(needsPasskeyAuth);
      } else {
        setPasskeyError("Authentication cancelled or failed");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  // Register a passkey for the current profile
  const handleRegisterPasskey = async () => {
    if (!current) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await registerPasskey(current);
      if (result?.ok) {
        // Update local state immediately - don't wait for async check
        setProfileHasPasskey(prev => ({ ...prev, [current]: true }));
        setShowPasskeySetup(false);
        setPasskeyError(null);
      } else if (result === null) {
        // User cancelled - not an error, just close
        setPasskeyError(null);
      } else {
        setPasskeyError("Setup cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey setup failed");
    }
    setPasskeyBusy(false);
  };

  // Debounced availability check as user types
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) {
      // Reset status while the debounced network check is pending — driving UI
      // state off an async external (name-availability) check. Intentional.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailability("idle");
      clearTimeout(checkTimerRef.current);
      return;
    }
    // If it's an existing local profile, it's "ours" — treat as available
    if (existing.some(e => e.toLowerCase() === trimmed.toLowerCase())) {
      setAvailability("available");
      return;
    }
    setAvailability("checking");
    clearTimeout(checkTimerRef.current);
    latestQueryRef.current = trimmed;
    checkTimerRef.current = setTimeout(async () => {
      const res = await checkProfileExists(trimmed);
      // Guard against stale responses — user may have typed more since
      if (latestQueryRef.current !== trimmed) return;
      if (res === null) setAvailability("network-err");
      else if (res.exists) setAvailability("taken");
      else setAvailability("available");
    }, 400);
    return () => clearTimeout(checkTimerRef.current);
  }, [name, existing]);

  const canSubmit = name.trim().length >= 2 && (availability === "available" || availability === "network-err") && !submitting;

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    // If it's an existing local profile, just activate — don't try to claim again
    const isLocalProfile = existing.some(e => e.toLowerCase() === trimmed.toLowerCase());
    const result = await onActivate(trimmed, { claim: !isLocalProfile });
    setSubmitting(false);
    if (!result?.ok) {
      if (result?.reason === "taken") {
        setAvailability("taken");
        setSubmitError("Someone just claimed that name. Try another.");
      } else {
        setSubmitError("Network hiccup. Try again?");
      }
    } else {
      // Success! For first-time users (no existing profiles), enter onboarding
      // sequence: passkey step (if supported) → BW step → home.
      // We always set claimedName so subsequent steps know which profile to
      // attach data to. The capability gate keeps unsupported devices on the
      // direct claim → BW path.
      if (existing.length === 0 && !isLocalProfile) {
        setClaimedName(trimmed);
        if (webAuthnSupported) {
          setShowPasskeyStep(true);
        } else {
          setShowBwStep(true);
        }
      }
    }
  };

  // Visual state for availability pip
  const availabilityPip = () => {
    if (availability === "checking")     return { colour: T.text3, icon: "…",  label: "checking" };
    if (availability === "available")    return { colour: T.sage,  icon: "✓",  label: existing.some(e=>e.toLowerCase()===name.trim().toLowerCase()) ? "on this device" : "available" };
    if (availability === "taken")        return { colour: T.rose,  icon: "✕",  label: "taken" };
    if (availability === "network-err")  return { colour: T.gold,  icon: "?",  label: "offline — try anyway" };
    return null;
  };
  const pip = availabilityPip();

  // Post-claim passkey step (first-time onboarding only). Sits between name
  // claim and BW step. Three exit paths all fall through to BW:
  //   1. User accepts and ceremony succeeds — passkey registered, advance
  //   2. User accepts but ceremony fails/cancels — log error, advance silently
  //   3. User taps "Later" — advance, no error
  // The home-screen chip will surface tomorrow if (1) didn't happen.
  if (showPasskeyStep) {
    const advanceToBw = () => {
      setShowPasskeyStep(false);
      setShowBwStep(true);
    };

    const handlePasskeyAccept = async () => {
      if (!claimedName || onboardingPasskeyBusy) return;
      setOnboardingPasskeyBusy(true);
      setOnboardingPasskeyError(null);
      try {
        const result = await registerPasskey(claimedName);
        if (result?.ok) {
          // Mark this profile as having a passkey in the local cache so the
          // existing ProfileScreen card respects it on later visits.
          setProfileHasPasskey(prev => ({ ...prev, [claimedName]: true }));
          advanceToBw();
        } else {
          // Cancellation or non-ok result — surface a soft message and let
          // them retry or skip. Don't auto-advance, give them control.
          setOnboardingPasskeyError(result === null ? null : "Setup didn't complete. Try again or skip for now.");
        }
      } catch (e) {
        console.error("[forge:onboarding-passkey]", e);
        setOnboardingPasskeyError(e.message || "Couldn't set up. Try again or skip.");
      }
      setOnboardingPasskeyBusy(false);
    };

    const handlePasskeyLater = () => {
      advanceToBw();
    };

    return (
      <div style={{
        background: "transparent", minHeight: "100vh", maxWidth: 430, margin: "0 auto",
        fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        {/* Sage ambient — wellness/security territory */}
        <div style={{position:"absolute",top:100,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${T.sage}26 0%,transparent 65%)`,pointerEvents:"none"}}/>

        <Fade d={0}>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.sage,
            letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
          }}>
            Secure across devices
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 36, fontWeight: 300, lineHeight: 1.15, marginBottom: 16 }}>
            Add a <span style={{fontStyle:"italic",color:T.sage}}>passkey</span>?
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 12 }}>
            Without one, your data lives only on this device — clearing your browser would lose everything.
          </p>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 32 }}>
            With one, your name is yours across phone, laptop, anywhere. Face ID, Touch ID, or your device PIN.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", flexDirection:"column", gap: 12, minHeight: 80 }}>
            {onboardingPasskeyError && (
              <div style={{padding:"10px 14px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:12,color:T.rose,maxWidth:320,textAlign:"center",lineHeight:1.5}}>
                {onboardingPasskeyError}
              </div>
            )}
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handlePasskeyAccept} disabled={onboardingPasskeyBusy} style={{
              width: "100%", padding: "18px 24px",
              background: T.sage, border: "none", borderRadius: T.r.lg,
              cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
              boxShadow: `0 12px 40px ${T.sage}33`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              opacity: onboardingPasskeyBusy ? 0.6 : 1,
            }}>
              <span>{onboardingPasskeyBusy ? "Setting up…" : "Add passkey"}</span>
              {!onboardingPasskeyBusy && <span style={{ fontSize: 18 }}>→</span>}
            </button>
            <button onClick={handlePasskeyLater} disabled={onboardingPasskeyBusy} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.sans, fontSize: 14, fontWeight: 400, color: T.text3,
            }}>
              Later
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  // Post-claim BW step for first-time users
  if (showBwStep) {
    const handleBwSave = () => {
      if (claimedName && updateBodyweight) {
        updateBodyweight(pendingBw);
      }
      setShowBwStep(false);
    };
    const handleBwSkip = () => {
      setShowBwStep(false);
    };

    return (
      <div style={{
        background: "transparent", minHeight: "100vh", maxWidth: 430, margin: "0 auto",
        fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        {/* Sage-tinted ambient glow — wellness territory, not training */}
        <div style={{position:"absolute",top:100,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${T.sage}26 0%,transparent 65%)`,pointerEvents:"none"}}/>

        <Fade d={0}>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.sage,
            letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
          }}>
            Bodyweight
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 36, fontWeight: 300, lineHeight: 1.15, marginBottom: 16 }}>
            What do you weigh?
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 32 }}>
            Optional — but it lets us track bodyweight movements (pull-ups, dips, planks) properly.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
            <ScrollDrum
              value={pendingBw}
              onChange={setPendingBw}
              min={40}
              max={200}
              step={0.5}
              unit="kg"
            />
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handleBwSave} style={{
              width: "100%", padding: "18px 24px",
              background: T.sage, border: "none", borderRadius: T.r.lg, cursor: "pointer",
              fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
              boxShadow: `0 12px 40px ${T.sage}33`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span>Save & continue</span>
              <span style={{ fontSize: 18 }}>→</span>
            </button>
            <button onClick={handleBwSkip} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: "pointer",
              fontFamily: T.sans, fontSize: 14, fontWeight: 400, color: T.text3,
            }}>
              Skip
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  return (
    <div style={{background:"transparent",minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",position:"relative",overflow:"clip"}}>
      <div style={{position:"absolute",top:100,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,marginBottom:32,display:"block"}}>← Back</button>}
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:36,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          {current?"Switch profile":"Who's training?"}
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:36,lineHeight:1.6}}>
          {current?"Pick a profile or add someone new.":"Pick a name. It travels with you across devices."}
        </p>
      </Fade>
      {existing.length>0&&(
        <Fade d={60}>
          <div style={{marginBottom:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>On this device</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {existing.map(n=>(
                <div key={n} style={{padding:"16px 20px",borderRadius:T.r.lg,background:n===current?`${T.coral}12`:T.bg2,border:`1px solid ${n===current?T.coral+"44":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
                  <span onClick={()=>onActivate(n)} style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,cursor:"pointer",flex:1}}>{n}</span>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    {n===current&&<span style={{fontSize:11,color:T.coral,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Active</span>}
                    <button onClick={()=>setConfirmWipe(n)} style={{background:"none",border:"none",padding:"2px 6px",cursor:"pointer",fontSize:11,color:T.text4,fontFamily:T.sans}} title="Wipe progress">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Fade>
      )}
      <Fade d={120}>
        <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
          {existing.length > 0 ? "Add new" : "Pick your name"}
        </div>
        <div style={{position:"relative"}}>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1,position:"relative"}}>
              <input value={name} onChange={e=>{setName(e.target.value); setSubmitError(null);}}
                onKeyDown={e=>{if(e.key==="Enter"&&canSubmit) handleSubmit();}}
                placeholder="Your name"
                autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck="false"
                style={{width:"100%",background:T.bg2,border:`1px solid ${availability==="taken"?T.rose+"55":availability==="available"?T.sage+"55":T.bg3}`,borderRadius:T.r.md,padding:"14px 48px 14px 16px",fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,outline:"none",caretColor:T.coral,transition:`border 180ms ${T.ease}`}}
              />
              {pip && (
                <div style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:6,pointerEvents:"none"}}>
                  <span style={{fontSize:14,color:pip.colour,fontWeight:500}}>{pip.icon}</span>
                </div>
              )}
            </div>
            <button onClick={handleSubmit} disabled={!canSubmit}
              style={{padding:"14px 20px",background:canSubmit?T.coral:T.bg3,border:"none",borderRadius:T.r.md,cursor:canSubmit?"pointer":"default",fontFamily:T.serif,fontSize:18,fontWeight:400,color:canSubmit?T.bg0:T.text4,transition:`all 200ms ${T.ease}`}}>
              {submitting ? "…" : "→"}
            </button>
          </div>
          {/* Subscript — availability status or helper text */}
          <div style={{marginTop:10,minHeight:16,fontSize:11,fontFamily:T.sans,color:pip?.colour || T.text3,display:"flex",alignItems:"center",gap:6,transition:`color 180ms ${T.ease}`}}>
            {submitError ? (
              <span style={{color:T.rose}}>{submitError}</span>
            ) : pip ? (
              <span>{pip.label === "available" && "Available · this will be your username"}
                    {pip.label === "on this device" && "Welcome back"}
                    {pip.label === "taken" && "Already taken on Forge"}
                    {pip.label === "checking" && "Checking…"}
                    {pip.label === "offline — try anyway" && "Couldn't check online — you can still proceed"}
              </span>
            ) : (
              <span style={{color:T.text4}}>2+ characters. Case doesn't matter.</span>
            )}
          </div>

          {/* Taken → escape hatch. Cross-device sign-in lives here once
              pairing ships. For now, surfaces an honest explainer. */}
          {availability === "taken" && (
            <button
              type="button"
              onClick={() => setShowTakenHelp(true)}
              style={{
                marginTop:12,background:"none",border:"none",padding:0,
                cursor:"pointer",fontFamily:T.sans,fontSize:12,
                color:T.coral,textAlign:"left",letterSpacing:"0.02em",
              }}>
              That's me →
            </button>
          )}
        </div>
      </Fade>

      {/* Tone-of-voice card — sets expectations on data + PII */}
      <Fade d={180}>
        <div className="forge-glass" style={{marginTop:36,padding:"18px 20px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
            No email. No phone.
          </div>
          <div style={{fontFamily:T.serif,fontSize:19,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
            We don&apos;t want your <span style={{fontStyle:"italic",color:T.coral}}>starsign</span> either.
          </div>
          <p style={{fontSize:13,color:T.text3,lineHeight:1.6}}>
            Forge keeps your data yours. A name is all we need — it syncs your streak and weights across your devices. Nothing more.
          </p>
        </div>
      </Fade>

      {/* Breather row — context-aware. When resting, it's the "Back to it"
          resume affordance (assurance: undo a pause any time, no need to
          train to clear it — Bk.end). Otherwise it's the manual entry to
          declare a pause. Same modal the Home nudge opens. */}
      {current && resting && onEndBreather ? (
        <Fade d={240}>
          <div className="forge-glass" style={{marginTop:36,padding:"14px 18px",border:`1px solid ${T.sage}33`,borderRadius:T.r.lg,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.sage}}>On a breather</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {restingReason ? `${reasonLabel(restingReason)} · your rhythm's paused` : "Your rhythm's paused"}
              </div>
            </div>
            <button onClick={onEndBreather}
              style={{flexShrink:0,padding:"8px 14px",background:"none",border:`1px solid ${T.sage}66`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.sage}}>
              Back to it
            </button>
          </div>
        </Fade>
      ) : current && onOpenBreather ? (
        <Fade d={240}>
          <button onClick={onOpenBreather}
            className="forge-glass" style={{width:"100%",textAlign:"left",marginTop:36,padding:"14px 18px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",color:"inherit"}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Need a breather?</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>Pause your rhythm while life happens</div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>→</span>
          </button>
        </Fade>
      ) : null}

      {/* Bodyweight row — tappable to edit */}
      {current && setBwEditOpen && (
        <Fade d={260}>
          <div onClick={()=>setBwEditOpen(true)}
            className="forge-glass" style={{marginTop:16,padding:"14px 18px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Bodyweight</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {bodyweight ? (
                  (() => {
                    const bwData = BW.get(current);
                    const daysAgo = bwData?.ageMs ? Math.floor(bwData.ageMs / 86400000) : null;
                    const agoStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : daysAgo !== null ? `${daysAgo} days ago` : "";
                    return `${bodyweight} kg${agoStr ? ` · updated ${agoStr}` : ""}`;
                  })()
                ) : "Not set — add one →"}
              </div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>→</span>
          </div>
        </Fade>
      )}

      {/* Training focus row — tappable to open the focus picker. Biases
          accessory rotation toward the chosen goal. Default = Forged (balanced). */}
      {current && onEditFocus && (
        <Fade d={270}>
          <div onClick={onEditFocus}
            className="forge-glass" style={{marginTop:12,padding:"14px 18px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Training focus</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {userFocus} · {FOCUS_SUMMARIES[userFocus] || FOCUS_SUMMARIES.Forged}
              </div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>→</span>
          </div>
        </Fade>
      )}

      {/* Passkey setup card — only show if WebAuthn is supported and profile doesn't have one */}
      {current && webAuthnSupported && !profileHasPasskey[current] && (
        <Fade d={280}>
          <div className="forge-glass" style={{marginTop:16,padding:"18px 20px",border:`1px solid ${T.sage}33`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
                  Secure your profile
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Use Face ID, Touch ID, or your device PIN to protect your data and sign in on other devices.
                </p>
              </div>
              <button
                onClick={handleRegisterPasskey}
                disabled={passkeyBusy}
                style={{
                  padding:"10px 16px",
                  background:T.sage,
                  border:"none",
                  borderRadius:T.r.md,
                  fontSize:13,
                  fontWeight:500,
                  color:T.bg0,
                  cursor:passkeyBusy?"default":"pointer",
                  opacity:passkeyBusy?0.6:1,
                  whiteSpace:"nowrap",
                }}
              >
                {passkeyBusy ? "..." : "Set up"}
              </button>
            </div>
            {passkeyError && (
              <div style={{marginTop:12,padding:"8px 12px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:11,color:T.rose}}>
                {passkeyError}
              </div>
            )}
          </div>
        </Fade>
      )}

      {/* Passkey enabled badge */}
      {current && profileHasPasskey[current] && (
        <Fade d={280}>
          <div className="forge-glass" style={{marginTop:16,padding:"14px 18px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:T.sage}}/>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Passkey enabled</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>Your profile is secured with biometric auth</div>
            </div>
          </div>
        </Fade>
      )}

      {/* ── Sync group — dropped to the bottom so the user-configurable rows
          (breather, bodyweight, focus, passkey) lead. Status kept (liked),
          just no longer top of the stack; Sync now + diagnostics follow. ── */}
      {current && (
        <Fade d={290}>
          <div style={{marginTop:36}}>
            <SyncStatusCard profile={current} />
          </div>
        </Fade>
      )}

      {current && (
        <Fade d={295}>
          <SyncNowRow profile={current} />
        </Fade>
      )}

      {/* Sync diagnostics — entry point to /diag-sync. PWAs have no address
          bar, so an in-app link is the only way to reach it from a standalone
          install. Plain <a> rather than next/link so the page is fetched fresh
          (it reads LS directly) and the route is independent of the SPA shell. */}
      {current && (
        <Fade d={300}>
          <a href="/diag-sync"
            className="forge-glass" style={{marginTop:12,padding:"14px 18px",border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,display:"flex",alignItems:"center",justifyContent:"space-between",textDecoration:"none",color:"inherit"}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Sync diagnostics</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>Local store counts + force pull/push</div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>↗︎</span>
          </a>
        </Fade>
      )}

      {/* Passkey auth required modal */}
      {needsPasskeyAuth && (
        <div onClick={()=>setNeedsPasskeyAuth(null)} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:T.r.xl,padding:"32px 28px",width:"90%",maxWidth:340,textAlign:"center"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
              Authentication required
            </div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.25,marginBottom:12}}>
              Verify it&apos;s you
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.55}}>
              This profile has a passkey. Use Face ID, Touch ID, or your device PIN to continue.
            </p>
            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}
            <button
              onClick={handlePasskeyAuth}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.coral,
                border:"none",
                borderRadius:T.r.lg,
                fontSize:16,
                fontWeight:500,
                color:T.bg0,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:12,
              }}
            >
              {passkeyBusy ? "Verifying..." : "Authenticate"}
            </button>
            <button
              onClick={()=>{setNeedsPasskeyAuth(null);setPasskeyError(null);}}
              style={{background:"none",border:"none",padding:"8px",fontSize:13,color:T.text3,cursor:"pointer"}}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmWipe&&(
        <div onClick={()=>!wipeBusy&&setConfirmWipe(null)} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.rose}33`,animation:`slideUp 240ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box"}}>
            <div style={{fontFamily:T.serif,fontSize:24,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
              Wipe <span style={{color:T.rose,fontStyle:"italic"}}>{confirmWipe}</span>?
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.6}}>
              Choose how far this goes. Local keeps your data in the cloud — you can reclaim the name by typing it again. Full wipe releases the name and deletes everything.
            </p>

            {wipeError && (
              <div style={{padding:"10px 14px",marginBottom:16,borderRadius:T.r.md,background:`${T.rose}14`,border:`1px solid ${T.rose}44`,fontSize:12,color:T.rose,lineHeight:1.5}}>
                {wipeError}
              </div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:false})}
                style={{padding:"16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.text1,lineHeight:1.3,marginBottom:3}}>
                  Remove from this device
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Cloud data stays. Reclaim the name any time.
                </div>
              </button>

              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:true})}
                style={{padding:"16px",background:`${T.rose}18`,border:`1px solid ${T.rose}55`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.rose,lineHeight:1.3,marginBottom:3}}>
                  {wipeBusy ? "Wiping…" : "Full wipe — cloud & device"}
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Deletes all weights, history, and the name claim. Can't be undone.
                </div>
              </button>
            </div>

            <button
              disabled={wipeBusy}
              onClick={()=>setConfirmWipe(null)}
              style={{width:"100%",padding:"12px",background:"none",border:"none",cursor:wipeBusy?"default":"pointer",fontFamily:T.sans,fontSize:13,color:T.text3}}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Taken name → passkey sign-in or fallback explainer */}
      {showTakenHelp && (
        <TakenNameModal
          name={name.trim()}
          webAuthnSupported={webAuthnSupported}
          onClose={() => setShowTakenHelp(false)}
          onActivate={onActivate}
          passkeyBusy={passkeyBusy}
          setPasskeyBusy={setPasskeyBusy}
          passkeyError={passkeyError}
          setPasskeyError={setPasskeyError}
        />
      )}

      {/* Bodyweight edit modal — rendered here so it works within ProfileScreen's early return */}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
    </div>
  );
}

// ─── Home ──────────────────────────────────��──────────────────────────────────
