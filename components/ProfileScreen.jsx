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
import { T, DISPLAY } from "@/lib/tokens";
import { LS, P, BW, blobDelete, checkProfileExists } from "@/lib/storage";
import {
  hasPasskey, registerPasskey, authenticatePasskey, isPlatformAuthenticatorAvailable,
} from "@/lib/webauthn";
import { FOCUS_SUMMARIES } from "@/lib/programme";
import { reasonLabel } from "@/lib/breaks";
import BugReportSheet from "@/components/BugReportSheet";
import BodyweightDrum from "@/components/BodyweightDrum";
import { isAdminSession } from "@/lib/auth-session";
import { useInlineModalA11y } from "@/lib/a11y";
import { PROFILE_SUFFIXES, LEGACY_PROFILE_KEY_PREFIXES } from "@/lib/store-health";
import { Fade } from "@/components/ui";
import { getThemePreference, applyThemePreference } from "@/lib/theme";
import Glyph from "@/components/Glyph";
import { SyncStatusCard, SyncNowRow } from "@/components/sync-cards";
import BodyweightEditModal from "@/components/BodyweightEditModal";
import TakenNameModal from "@/components/TakenNameModal";

// Mirrors the server rule (validateProfile in app/api/sync/route.js): path
// separators and control characters are rejected there with a 400, and the
// 64-char hard cap matches PROFILE_MAX_LEN. Catching them here means a plain
// message at the input instead of a dead-end "network hiccup" on submit.
const NAME_BLOCKED_RE = /[/\\\u0000-\u001F\u007F]/;
const NAME_MAX_LEN = 64;

// Sun · Auto · Moon — the appearance switch. Selection is the card
// (§12.3, turned horizontal): three cells on the ground, the chosen one
// lifts to surface with the whisper elevation. Sun and moon are drawn
// glyphs; Auto is a WORD — it names a behaviour, not a thing, and words
// belong to the text face. Compact control → 8px radius (§12.1).
function ThemeSwitch({ value, onChange }) {
  const cells = [
    { id: "light", glyph: "sun",  lit: T.sun,  label: "Always light" },
    { id: "auto",  word:  "Auto",              label: "Follow the device setting" },
    { id: "dark",  glyph: "moon", lit: T.moon, label: "Always dark" },
  ];
  return (
    <div role="radiogroup" aria-label="Appearance"
      style={{display:"inline-flex",border:`1px solid ${T.rule}`,borderRadius:T.rSm,padding:2,flexShrink:0}}>
      {cells.map(c => {
        const sel = value === c.id;
        return (
          <button key={c.id} role="radio" aria-checked={sel} aria-label={c.label}
            onClick={() => onChange(c.id)}
            style={{
              minWidth:44,height:32,padding:"0 10px",border:"none",cursor:"pointer",
              display:"inline-flex",alignItems:"center",justifyContent:"center",
              borderRadius:T.rSm-2,fontFamily:T.text,fontSize:12,fontWeight:500,
              background:sel?T.surface:"transparent",
              boxShadow:sel?T.elev:"none",
              // Lit when chosen: the sun warms (oxide), the moon cools
              // (slate) — the light-up rides the give timing, not the
              // cell swap.
              color:sel?(c.lit||T.ink):(c.word?T.ink2:T.ink3),
              transition:`background 180ms ${T.ease}, color 380ms ${T.ease}`,
            }}>
            {c.glyph ? <Glyph name={c.glyph} size={14}/> : c.word}
          </button>
        );
      })}
    </div>
  );
}

export default function ProfileScreen({existing,current,onActivate,onCancel,bodyweight=null,bwEditOpen=false,setBwEditOpen,updateBodyweight,userFocus="Forged",onEditFocus,onOpenBreather=null,resting=false,restingReason=null,onEndBreather=null}){
  const [name,setName]=useState("");
  // Per-profile preference. State carries the profile it was read for and
  // adjusts DURING render when the shown profile changes (the derived-state
  // pattern — an effect would set state after a paint of the stale value).
  // Lazy init: SSR has no localStorage; the pre-paint script in layout.jsx
  // has already applied the stored value by the time we mount.
  const [themeState,setThemeState]=useState(()=>({profile:current, pref: typeof window==="undefined"?"auto":getThemePreference(current)}));
  if (themeState.profile !== current) setThemeState({profile:current, pref:getThemePreference(current)});
  const themePref = themeState.pref;
  const handleThemeChange=(pref)=>{ applyThemePreference(current, pref); setThemeState({profile:current, pref}); };
  const [confirmWipe,setConfirmWipe]=useState(null);
  const [showTakenHelp,setShowTakenHelp]=useState(false);
  // availability: "idle" | "checking" | "available" | "taken" | "invalid" | "network-err"
  const [availability,setAvailability]=useState("idle");
  const [submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState(null);
  const checkTimerRef = useRef(null);
  const latestQueryRef = useRef("");

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
  const [bugSheetOpen, setBugSheetOpen] = useState(false);

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
      // null = check failed — keep whatever we knew rather than storing a
      // guess. Only update if not already true (preserves local
      // registration state).
      if (has === null) return;
      setProfileHasPasskey(prev => prev[profile] === true ? prev : { ...prev, [profile]: has });
    });
    // Also explicitly check current profile if not checked
    if (current && !checkedProfilesRef.current.has(current)) {
      checkedProfilesRef.current.add(current);
      hasPasskey(current).then(has => {
        if (has === null) return;
        setProfileHasPasskey(prev => prev[current] === true ? prev : { ...prev, [current]: has });
      });
    }
  }, [existing, current]);

  // Expanded wipe: opts.cloud === true also nukes cloud data via DELETE /api/sync.
  // opts.cloud === false only clears local storage (fast, offline-safe).
  const [wipeBusy,setWipeBusy]=useState(false);
  const [wipeError,setWipeError]=useState(null);

  // Dialog a11y for the two inline destructive/auth sheets — focus into the
  // dialog on open, restore on close, Escape to dismiss, Tab trapped inside.
  // Same contract the other 13 sheets get from useModalA11y; the inline variant
  // keys on the open flag since these render conditionally inside ProfileScreen.
  const { containerRef: wipeRef, onKeyDown: wipeKeyDown } = useInlineModalA11y(!!confirmWipe, () => { if (!wipeBusy) setConfirmWipe(null); });
  const { containerRef: authRef, onKeyDown: authKeyDown } = useInlineModalA11y(!!needsPasskeyAuth, () => { setNeedsPasskeyAuth(null); setPasskeyError(null); });

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
    // Local cleanup always runs regardless of cloud branch. Iterate the
    // CANONICAL per-profile registry (store-health.js), not a hand-typed
    // subset — the old 5-key list left stamps/drafts/trainingState/days
    // behind, and those ghosts re-merged (and re-pushed) when the name was
    // reclaimed, resurrecting the wiped profile and bleeding one user's
    // data into the next on a shared device (audit #5).
    PROFILE_SUFFIXES.forEach(s => localStorage.removeItem(`forge:${n}:${s}`));
    localStorage.removeItem(`forge:${n}:pendingPushes`); // historic key, belt-and-braces
    // Abandoned week-keyed legacy stores under this profile's namespace
    // (explicitly enumerated patterns — never a bare prefix glob).
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && LEGACY_PROFILE_KEY_PREFIXES.some(p => k.startsWith(`forge:${n}:${p}`))) {
        localStorage.removeItem(k);
      }
    }
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
    // Blocked characters — no point asking the server, it would 400 anyway.
    if (NAME_BLOCKED_RE.test(trimmed)) {
      setAvailability("invalid");
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

  // Visual state for availability pip. Glyph names, not characters — every
  // symbol is drawn (§10.5); checking carries no glyph, the label suffices.
  const availabilityPip = () => {
    if (availability === "checking")     return { colour: T.ink3,    glyph: null,    label: "checking" };
    if (availability === "available")    return { colour: T.ink2,    glyph: "check", label: existing.some(e=>e.toLowerCase()===name.trim().toLowerCase()) ? "on this device" : "available" };
    if (availability === "taken")        return { colour: T.heat[4], glyph: "cross", label: "taken" };
    if (availability === "invalid")      return { colour: T.heat[4], glyph: "cross", label: "invalid" };
    if (availability === "network-err")  return { colour: T.ink2,    glyph: "info",  label: "offline · try anyway" };
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
        fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        <Fade d={0}>
          <div style={{ fontSize: 13, color: T.ink3, marginBottom: 18 }}>
            Secure across devices
          </div>
          <div style={{ ...DISPLAY, fontSize: 38, color: T.ink, marginBottom: 16 }}>
            A passkey
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 12 }}>
            Add one? Without it, your data lives only on this device — clearing your browser would lose everything.
          </p>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 32 }}>
            With one, your name is yours across phone, laptop, anywhere. Face ID, Touch ID, or your device PIN.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", flexDirection:"column", gap: 12, minHeight: 80 }}>
            {onboardingPasskeyError && (
              <div style={{padding:"10px 14px",borderRadius:T.r,background:T.surface,boxShadow:T.elev,fontSize:13,color:T.ink,maxWidth:320,textAlign:"center",lineHeight:1.5}}>
                {onboardingPasskeyError}
              </div>
            )}
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handlePasskeyAccept} disabled={onboardingPasskeyBusy} style={{
              width: "100%", height: 58, padding: "0 22px",
              background: T.commit, border: "none", borderRadius: T.r,
              cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.text, fontSize: 17, fontWeight: 500, color: T.commitInk,
              boxShadow: T.elevStrong,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              opacity: onboardingPasskeyBusy ? 0.6 : 1,
            }}>
              <span>{onboardingPasskeyBusy ? "Setting up…" : "Add passkey"}</span>
              {!onboardingPasskeyBusy && <Glyph name="arrowRight" size={14}/>}
            </button>
            <button onClick={handlePasskeyLater} disabled={onboardingPasskeyBusy} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: onboardingPasskeyBusy ? "default" : "pointer",
              fontFamily: T.text, fontSize: 14, fontWeight: 400, color: T.ink3,
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
        fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        <Fade d={0}>
          <div style={{ fontSize: 13, color: T.ink3, marginBottom: 18 }}>
            One measurement
          </div>
          <div style={{ ...DISPLAY, fontSize: 38, color: T.ink, marginBottom: 16 }}>
            Bodyweight
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 32 }}>
            What do you weigh? Optional — but it lets us track bodyweight movements (pull-ups, dips, planks) properly.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
            <BodyweightDrum value={pendingBw} onChange={setPendingBw} />
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button className="forge-press" onClick={handleBwSave} style={{
              width: "100%", height: 58, padding: "0 22px",
              background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
              fontFamily: T.text, fontSize: 17, fontWeight: 500, color: T.commitInk,
              boxShadow: T.elevStrong,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span>Save & continue</span>
              <Glyph name="arrowRight" size={14}/>
            </button>
            <button onClick={handleBwSkip} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: "pointer",
              fontFamily: T.text, fontSize: 14, fontWeight: 400, color: T.ink3,
            }}>
              Skip
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  return (
    <div style={{background:"transparent",minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",position:"relative",overflow:"clip"}}>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:13,color:T.ink2,fontFamily:T.text,marginBottom:32,display:"inline-flex",alignItems:"center",gap:5}}><Glyph name="arrowLeft" size={12} color={T.ink3}/> Home</button>}
      <Fade d={0}>
        {/* Kicker — the room's scope. Never absent (§11.3). */}
        <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>
          {current?"This device":"First run"}
        </div>
        <div style={{...DISPLAY,fontSize:38,color:T.ink,marginBottom:10}}>
          {current?"Profiles":"Your name"}
        </div>
        <p style={{fontSize:14,color:T.ink2,marginBottom:36,lineHeight:1.6}}>
          {current?"Pick a profile or add someone new.":"Who's training? Pick a name — it travels with you across devices."}
        </p>
      </Fade>
      {existing.length>0&&(
        <Fade d={60}>
          {/* Rows between hairlines on the ground — settings are a list,
              not a stack of documents (§11.2). */}
          <div style={{marginBottom:28,borderTop:`1px solid ${T.rule}`}}>
            {existing.map(n=>(
              <div key={n} style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span onClick={()=>onActivate(n)} style={{fontSize:17,fontWeight:n===current?500:400,color:T.ink,cursor:"pointer",flex:1}}>{n}</span>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  {n===current&&<span style={{fontSize:12,color:T.ink2,fontWeight:500}}>Active</span>}
                  <button onClick={()=>setConfirmWipe(n)} style={{background:"none",border:"none",padding:"2px 6px",cursor:"pointer"}} title="Wipe progress" aria-label={`Wipe ${n}`}><Glyph name="cross" size={11} color={T.ink3}/></button>
                </div>
              </div>
            ))}
          </div>
        </Fade>
      )}
      <Fade d={120}>
        <div style={{fontSize:13,color:T.ink3,marginBottom:12}}>
          {existing.length > 0 ? "Add new" : "Pick your name"}
        </div>
        <div style={{position:"relative"}}>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1,position:"relative"}}>
              <input value={name} onChange={e=>{setName(e.target.value); setSubmitError(null);}}
                onKeyDown={e=>{if(e.key==="Enter"&&canSubmit) handleSubmit();}}
                placeholder="Your name" maxLength={NAME_MAX_LEN}
                aria-label="Your name"
                // The status line below carries the rules AND the live result
                // (available / taken / invalid). Pointing at it means a screen
                // reader gets the constraints on focus, not just after failing.
                aria-describedby="name-status"
                aria-invalid={availability === "taken" || availability === "invalid" || !!submitError}
                autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck="false"
                style={{width:"100%",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,padding:"14px 48px 14px 16px",fontFamily:T.text,fontSize:17,fontWeight:500,color:T.ink,outline:"none",caretColor:T.commit,transition:`box-shadow 180ms ${T.ease}`}}
              />
              {pip && (
                // Decorative: the same state is announced in the status line
                // below, so exposing the glyph too would read it twice.
                <div aria-hidden="true" style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:6,pointerEvents:"none"}}>
                  {pip.glyph && <Glyph name={pip.glyph} size={12} color={pip.colour}/>}
                </div>
              )}
            </div>
            <button className={canSubmit?"forge-press":undefined} onClick={handleSubmit} disabled={!canSubmit}
              style={{padding:"14px 20px",background:canSubmit?T.commit:T.well,border:"none",borderRadius:T.r,cursor:canSubmit?"pointer":"default",fontFamily:T.text,fontSize:17,fontWeight:500,color:canSubmit?T.commitInk:T.ink3,boxShadow:canSubmit?T.elevStrong:"none",transition:`background 200ms ${T.ease}`}}>
              {submitting ? "…" : <Glyph name="arrowRight" size={15}/>}
            </button>
          </div>
          {/* Subscript — availability status or helper text */}
          {/* Status line. role=status + aria-live announces availability and
              errors as they change — previously the only signal was a coloured
              glyph and a disabled button, which told a screen-reader user
              nothing about WHY they were stuck. */}
          <div id="name-status" role="status" aria-live="polite"
            style={{marginTop:10,minHeight:16,fontSize:12,fontFamily:T.text,color:pip?.colour || T.ink3,display:"flex",alignItems:"center",gap:6,transition:`color 180ms ${T.ease}`}}>
            {submitError ? (
              <span style={{color:T.heat[4]}}>{submitError}</span>
            ) : pip ? (
              <span>{pip.label === "available" && "Available · this will be your username"}
                    {pip.label === "on this device" && "Welcome back"}
                    {pip.label === "taken" && "Already taken on Heatwayve"}
                    {pip.label === "invalid" && "No slashes, dots-only names, or control characters — they don't survive syncing"}
                    {pip.label === "checking" && "Checking…"}
                    {pip.label === "offline · try anyway" && "Couldn't check from here. Claim it and see."}
              </span>
            ) : name.trim().length === 1 ? (
              // Previously silent: one character left the button disabled with
              // no stated reason.
              <span style={{color:T.ink3}}>A bit more — names need 2 characters or more.</span>
            ) : (
              <span style={{color:T.ink3}}>2 characters or more, no slashes. Case doesn&apos;t matter.</span>
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
                cursor:"pointer",fontFamily:T.text,fontSize:12,
                color:T.ink,textDecoration:"underline",textUnderlineOffset:3,textAlign:"left",
                display:"inline-flex",alignItems:"center",gap:4,
              }}>
              That&apos;s me <Glyph name="arrowRight" size={11}/>
            </button>
          )}
        </div>
      </Fade>

      {/* Tone-of-voice card — sets expectations on data + PII. Shown only at
          the create moment (no active profile): it's a trust pitch for the
          door, not permanent settings furniture. */}
      {!current && <Fade d={180}>
        <div style={{marginTop:36,padding:"18px 20px",background:T.surface,boxShadow:T.elev,borderRadius:T.r}}>
          <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>
            No email. No phone.
          </div>
          <div style={{fontSize:17,fontWeight:500,color:T.ink,lineHeight:1.35,marginBottom:6}}>
            We don&apos;t want your starsign either.
          </div>
          <p style={{fontSize:13,color:T.ink2,lineHeight:1.6}}>
            Heatwayve keeps your data yours. A name is all we need — it syncs your streak and weights across your devices. Nothing more.
          </p>
        </div>
      </Fade>}

      {/* Breather row — context-aware. When resting, it's the "Back to it"
          resume affordance (assurance: undo a pause any time, no need to
          train to clear it — Bk.end). Otherwise it's the manual entry to
          declare a pause. Same modal the Home nudge opens. */}
      {/* §11.2 — settings are ROWS between hairlines on the ground, not a
          stack of surface cards. Each row: title + state left, drawn arrow
          right, hairline under. */}
      {current && resting && onEndBreather ? (
        <Fade d={240}>
          <div style={{marginTop:36,padding:"15px 2px",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>On a breather</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>
                {restingReason ? `${reasonLabel(restingReason)} · your rhythm's paused` : "Your rhythm's paused"}
              </div>
            </div>
            <button className="forge-press" onClick={onEndBreather}
              style={{flexShrink:0,padding:"10px 16px",background:"transparent",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:13,fontWeight:500,color:T.ink}}>
              Back to it
            </button>
          </div>
        </Fade>
      ) : current && onOpenBreather ? (
        <Fade d={240}>
          <button onClick={onOpenBreather}
            className="forge-press forge-tint" style={{width:"100%",textAlign:"left",marginTop:36,padding:"15px 2px",background:"none",border:"none",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",color:"inherit",fontFamily:T.text}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Need a breather?</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>Pause your rhythm while life happens</div>
            </div>
            <Glyph name="arrowRight" size={13} color={T.ink3}/>
          </button>
        </Fade>
      ) : null}

      {/* Bodyweight row — tappable to edit */}
      {current && setBwEditOpen && (
        <Fade d={260}>
          <div onClick={()=>setBwEditOpen(true)}
            className="forge-press forge-tint" style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Bodyweight</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>
                {bodyweight ? (
                  (() => {
                    const bwData = BW.get(current);
                    const daysAgo = bwData?.ageMs ? Math.floor(bwData.ageMs / 86400000) : null;
                    const agoStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : daysAgo !== null ? `${daysAgo} days ago` : "";
                    return `${bodyweight} kg${agoStr ? ` · updated ${agoStr}` : ""}`;
                  })()
                ) : "Not set — tap to add one"}
              </div>
            </div>
            <Glyph name="arrowRight" size={13} color={T.ink3}/>
          </div>
        </Fade>
      )}

      {/* Training focus row — tappable to open the focus picker. Biases
          accessory rotation toward the chosen goal. Default = Forged (balanced). */}
      {current && onEditFocus && (
        <Fade d={270}>
          <div onClick={onEditFocus}
            className="forge-press forge-tint" style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Training focus</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>
                {userFocus} · {FOCUS_SUMMARIES[userFocus] || FOCUS_SUMMARIES.Forged}
              </div>
            </div>
            <Glyph name="arrowRight" size={13} color={T.ink3}/>
          </div>
        </Fade>
      )}

      {/* Appearance row — device-level, not per-profile (lib/theme.js).
          The switch is the control; the row itself doesn't tap. */}
      {current && (
        <Fade d={275}>
          <div style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Appearance</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>
                {themePref === "light" ? "Always light" : themePref === "dark" ? "Always dark" : "Follows your device"}
              </div>
            </div>
            <ThemeSwitch value={themePref} onChange={handleThemeChange}/>
          </div>
        </Fade>
      )}

      {/* Passkey setup card — only show if WebAuthn is supported and profile doesn't have one */}
      {/* Setup card only on a CONFIRMED "no passkey" — unknown (check
          failed / still in flight) shows nothing. Nagging off a failed
          check reads as "sync broke". */}
      {current && webAuthnSupported && profileHasPasskey[current] === false && (
        <Fade d={280}>
          <div style={{marginTop:16,padding:"18px 20px",background:T.surface,boxShadow:T.elev,borderRadius:T.r}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,color:T.ink3,marginBottom:6}}>
                  Secure your profile
                </div>
                <div style={{fontSize:16,fontWeight:500,color:T.ink,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:13,color:T.ink2,lineHeight:1.5}}>
                  Use Face ID, Touch ID, or your device PIN to protect your data and sign in on other devices.
                </p>
              </div>
              <button
                onClick={handleRegisterPasskey}
                disabled={passkeyBusy}
                style={{
                  padding:"10px 16px",
                  background:T.commit,
                  border:"none",
                  borderRadius:T.r,
                  fontSize:13,
                  fontWeight:500,
                  fontFamily:T.text,
                  color:T.commitInk,
                  boxShadow:T.elevStrong,
                  cursor:passkeyBusy?"default":"pointer",
                  opacity:passkeyBusy?0.6:1,
                  whiteSpace:"nowrap",
                }}
              >
                {passkeyBusy ? "..." : "Set up"}
              </button>
            </div>
            {passkeyError && (
              <div style={{marginTop:12,fontSize:12,color:T.heat[4]}}>
                {passkeyError}
              </div>
            )}
          </div>
        </Fade>
      )}

      {/* Passkey enabled row */}
      {current && profileHasPasskey[current] && (
        <Fade d={280}>
          <div style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Passkey enabled</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>Your profile is secured with biometric auth</div>
            </div>
            <Glyph name="check" size={13} color={T.ink3}/>
          </div>
        </Fade>
      )}

      {/* ── Sync group — dropped to the bottom so the user-configurable rows
          (breather, bodyweight, focus, passkey) lead. Status kept (liked),
          just no longer top of the stack; Sync now + diagnostics follow. ── */}
      {current && (
        <Fade d={290}>
          <div style={{marginTop:36}}>
            <SyncStatusCard profile={current} hasPasskey={profileHasPasskey[current]} />
          </div>
        </Fade>
      )}

      {current && (
        <Fade d={295}>
          <SyncNowRow profile={current} hasPasskey={profileHasPasskey[current]} />
        </Fade>
      )}

      {/* ── Admin wing (boss, 2026-07-26) — single-admin recognition, not a
          role system. Appears when THIS session's ceremony was minted as
          ADMIN_PROFILE (UI hint only; every admin API re-verifies the
          token's profile server-side). Reveals after any Face ID moment —
          signing in, or unlocking photos — and hides for everyone else,
          which also DECLUTTERS the ordinary Profile: sync diagnostics now
          live here rather than on every user's page. Plain <a> links so
          the pages fetch fresh (they read LS directly). */}
      {current && isAdminSession(current) && (
        <Fade d={298}>
          <div style={{marginTop:24,marginBottom:2,fontSize:13,color:T.ink3}}>
            Your keys, boss
          </div>
        </Fade>
      )}
      {current && isAdminSession(current) && (
        <Fade d={300}>
          <a href="/diag-bugs"
            style={{marginTop:4,padding:"15px 2px",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",textDecoration:"none",color:"inherit"}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Bug reports</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>The list — fill or kill</div>
            </div>
            <Glyph name="arrowUpRight" size={13} color={T.ink3}/>
          </a>
        </Fade>
      )}
      {current && isAdminSession(current) && (
        <Fade d={302}>
          <a href="/diag-sync"
            style={{padding:"15px 2px",borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",textDecoration:"none",color:"inherit"}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Sync diagnostics</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>Local store counts + force pull/push</div>
            </div>
            <Glyph name="arrowUpRight" size={13} color={T.ink3}/>
          </a>
        </Fade>
      )}

      {/* Bug report intake (fill-or-kill flow) — a quiet row in the admin-
          adjacent tail of the page. Open to everyone; the review wing lives
          at /diag-bugs. */}
      {current && (
        <Fade d={305}>
          <button onClick={() => setBugSheetOpen(true)}
            style={{width:"100%",padding:"15px 2px",background:"none",border:"none",borderBottom:`1px solid ${T.rule}`,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",color:"inherit",textAlign:"left",fontFamily:T.text}}>
            <div>
              <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Report a bug</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2}}>Something off? Tell me where it hurts.</div>
            </div>
            <Glyph name="arrowRight" size={13} color={T.ink3}/>
          </button>
        </Fade>
      )}

      {bugSheetOpen && <BugReportSheet profileName={current} onClose={() => setBugSheetOpen(false)} />}

      {/* The tip jar (boss, 2026-07-24; BMAC handle wired via FUNDING.yml
          2026-07-26). DISCREET by decree: a whisper at the end of the page,
          never a nag, never a modal, payment entirely off our surface.
          Copy: boss's own phrase, verbatim — intimacy pass may season it. */}
      {current && (
        <Fade d={310}>
          <a href="https://buymeacoffee.com/heatwayve" target="_blank" rel="noopener noreferrer"
            style={{marginTop:24,display:"block",textAlign:"center",fontFamily:T.text,fontSize:13,color:T.ink3,textDecoration:"none"}}>
            Buy me a protein shake <Glyph name="arrowUpRight" size={11}/>
          </a>
        </Fade>
      )}

      {/* Passkey auth required modal */}
      {needsPasskeyAuth && (
        <div onKeyDown={authKeyDown} onClick={()=>setNeedsPasskeyAuth(null)} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div ref={authRef} role="dialog" aria-modal="true" aria-labelledby="auth-title" tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-vellum" style={{borderRadius:T.r,padding:"32px 28px",width:"90%",maxWidth:340,textAlign:"center",outline:"none",boxShadow:"0 10px 24px -14px rgba(36,28,25,0.35)"}}>
            <div style={{fontSize:13,color:T.ink3,marginBottom:10}}>
              Authentication required
            </div>
            <div id="auth-title" style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:12}}>
              Verify it&apos;s you
            </div>
            <p style={{fontSize:13,color:T.ink2,marginBottom:24,lineHeight:1.55}}>
              This profile has a passkey. Use Face ID, Touch ID, or your device PIN to continue.
            </p>
            {passkeyError && (
              <div style={{marginBottom:16,fontSize:13,color:T.heat[4]}}>
                {passkeyError}
              </div>
            )}
            <button
              onClick={handlePasskeyAuth}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.commit,
                border:"none",
                borderRadius:T.r,
                fontSize:15,
                fontWeight:500,
                fontFamily:T.text,
                color:T.commitInk,
                boxShadow:T.elevStrong,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:12,
              }}
            >
              {passkeyBusy ? "Verifying…" : "Authenticate"}
            </button>
            <button
              onClick={()=>{setNeedsPasskeyAuth(null);setPasskeyError(null);}}
              style={{background:"none",border:"none",padding:"8px",fontSize:13,color:T.ink3,cursor:"pointer",fontFamily:T.text}}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmWipe&&(
        <div onKeyDown={wipeKeyDown} onClick={()=>!wipeBusy&&setConfirmWipe(null)} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div ref={wipeRef} role="dialog" aria-modal="true" aria-labelledby="wipe-title" tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={{padding:"26px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",animation:`slideUp 240ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box",outline:"none"}}>
            <div id="wipe-title" style={{...DISPLAY,fontSize:28,color:T.ink,marginBottom:8}}>
              Delete {confirmWipe}?
            </div>
            {/* A CONFIRMED passkey-less profile has never synced (the sync
                gate requires proof of control) and cannot hold photos (the
                camera requires a passkey) — so "cloud vs device" is a
                question with one honest answer, and asking it only invents
                worry. Unknown passkey state (check failed / in flight)
                keeps the full dialog: never assume less data than there
                might be. The delete paths themselves are unchanged. */}
            {profileHasPasskey[confirmWipe] === false ? (
              <p style={{fontSize:13,color:T.ink2,marginBottom:22,lineHeight:1.6}}>
                This profile lives only on this device. Without a passkey nothing ever synced, so there&apos;s no copy anywhere else. Deleting it removes everything, permanently.
              </p>
            ) : (
            <p style={{fontSize:13,color:T.ink2,marginBottom:22,lineHeight:1.6}}>
              Choose how far this goes. Local keeps your data in the cloud — you can reclaim the name by typing it again. Full wipe releases the name and deletes everything.
            </p>
            )}

            {wipeError && (
              <div style={{marginBottom:16,fontSize:13,color:T.heat[4],lineHeight:1.5}}>
                {wipeError}
              </div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
              {profileHasPasskey[confirmWipe] === false ? (
                <button
                  disabled={wipeBusy}
                  onClick={()=>wipeProfile(confirmWipe,{cloud:false})}
                  style={{padding:"16px",background:T.surface,border:"none",boxShadow:`inset 0 0 0 1px ${T.heat[4]}`,borderRadius:T.r,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1,fontFamily:T.text}}>
                  <div style={{fontSize:15,fontWeight:500,color:T.heat[4],lineHeight:1.3,marginBottom:3}}>
                    {wipeBusy ? "Deleting…" : "Delete this profile"}
                  </div>
                  <div style={{fontSize:13,color:T.ink3,lineHeight:1.5}}>
                    Everything lives on this device only. Can&apos;t be undone.
                  </div>
                </button>
              ) : (<>
              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:false})}
                style={{padding:"16px",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1,fontFamily:T.text}}>
                <div style={{fontSize:15,fontWeight:500,color:T.ink,lineHeight:1.3,marginBottom:3}}>
                  Remove from this device
                </div>
                <div style={{fontSize:13,color:T.ink3,lineHeight:1.5}}>
                  Cloud data stays. Reclaim the name any time.
                </div>
              </button>

              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:true})}
                style={{padding:"16px",background:T.surface,border:"none",boxShadow:`inset 0 0 0 1px ${T.heat[4]}`,borderRadius:T.r,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1,fontFamily:T.text}}>
                <div style={{fontSize:15,fontWeight:500,color:T.heat[4],lineHeight:1.3,marginBottom:3}}>
                  {wipeBusy ? "Wiping…" : "Full wipe · cloud & device"}
                </div>
                <div style={{fontSize:13,color:T.ink3,lineHeight:1.5}}>
                  Deletes all weights, history, and the name claim. Can&apos;t be undone.
                </div>
              </button>
              </>)}
            </div>

            <button
              disabled={wipeBusy}
              onClick={()=>setConfirmWipe(null)}
              style={{width:"100%",padding:"12px",background:"none",border:"none",cursor:wipeBusy?"default":"pointer",fontFamily:T.text,fontSize:13,color:T.ink3}}>
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
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight} profileName={current}/>
    </div>
  );
}

// ─── Home ──────────────────────────────────��──────────────────────────────────
