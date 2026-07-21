"use client";

// components/TakenNameModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shown when a user tries to claim a name that already exists — offers passkey
// sign-in if the profile has one. Extracted from ForgeApp.jsx during the PR3
// real-routes migration (stage 3c-final). The "auth-touching" deps are plain
// module imports (webauthn + storage); no ForgeApp closure coupling. Verbatim,
// behaviour-preserving. `slideUp` is a CSS keyframe in globals.css.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { useModalA11y } from "@/lib/a11y";
import { T } from "@/lib/tokens";
import { P } from "@/lib/storage";
import { hasPasskey, authenticatePasskey } from "@/lib/webauthn";
import { cacheAuthToken } from "@/lib/auth-session";

export default function TakenNameModal({ name, webAuthnSupported, onClose, onActivate, passkeyBusy, setPasskeyBusy, passkeyError, setPasskeyError }) {
  const [hasProfilePasskey, setHasProfilePasskey] = useState(null); // null = checking
  const [authSuccess, setAuthSuccess] = useState(false);

  // Check if this profile has a passkey + warm the sign-in path. Two
  // network calls fired in sequence on modal mount: hasPasskey() reveals
  // whether to show the Sign-in-with-passkey button at all; if it returns
  // true, fire a no-await POST to /api/auth/login-options purely to warm
  // the serverless function pool. The challenge that route issues lands
  // in blob storage with allowOverwrite: true, so the REAL options call
  // when the user actually taps the button overwrites it cleanly — no
  // stale-challenge leak. Trade-off: one wasted Vercel function invocation
  // per modal mount (cheap on Pro plan) in exchange for the user's first
  // tap hitting an already-warm function. Closes the "first attempt errors,
  // second succeeds" pattern that traces to cold-start latency on the
  // blob read inside /api/auth/login-options.
  useEffect(() => {
    hasPasskey(name).then(has => {
      setHasProfilePasskey(has);
      if (has) {
        fetch("/api/auth/login-options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: name }),
        }).catch(() => { /* warm-up failure is non-fatal — real call retries */ });
      }
    });
  }, [name]);

  const handlePasskeySignIn = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(name);
      if (result?.verified) {
        // Seed the in-memory auth session so photo flows don't re-prompt
        // Face ID within the token's lifetime (one ceremony per visit).
        if (result.authToken) cacheAuthToken(name, result.authToken);
        setAuthSuccess(true);
        // Add profile locally and activate, then call onActivate to update React state
        P.add(name);
        P.setActive(name);
        // Give user a moment to see success state, then activate properly
        setTimeout(() => {
          onActivate(name, { claim: false });
        }, 800);
      } else {
        setPasskeyError("Authentication cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "taken-name-title";

  if (authSuccess) {
    return (
      <div className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:T.bg2,borderRadius:T.r.xl,padding:"40px 32px",textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:16}}>✓</div>
          <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text1}}>
            Welcome back, {name}
          </div>
          <p style={{fontSize:13,color:T.text3,marginTop:8}}>Fetching your stuff…</p>
        </div>
      </div>
    );
  }

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{overscrollBehavior:"contain",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={e=>e.stopPropagation()} className="forge-sheet-ground" style={{background:T.bg2,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",borderTop:`1px solid ${T.coral}33`,animation:`slideUp 260ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box",position:"relative",outline:"none"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Is this you?
        </div>
        <div id={titleId} style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:12}}>
          {hasProfilePasskey === null ? "Checking…" : hasProfilePasskey ? "Sign in with passkey" : "Signing in on a new device"}
        </div>

        {/* If profile has passkey and WebAuthn is supported, show sign-in option */}
        {webAuthnSupported && hasProfilePasskey && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is secured with a passkey. Use Face ID, Touch ID, or your device PIN to sign in.
            </p>

            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}

            <button
              onClick={handlePasskeySignIn}
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
                marginBottom:16,
              }}
            >
              {passkeyBusy ? "Verifying…" : "Sign in with passkey"}
            </button>

            <p style={{fontSize:11,color:T.text4,textAlign:"center",lineHeight:1.5}}>
              Lost access to your passkey? Contact support to recover your account.
            </p>
          </>
        )}

        {/* Fallback: no passkey or WebAuthn not supported */}
        {(!webAuthnSupported || hasProfilePasskey === false) && hasProfilePasskey !== null && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is claimed but doesn&apos;t have a passkey set up. You&apos;ll need to wipe it from the original device to reclaim it here.
            </p>

            <div style={{padding:"14px 16px",borderRadius:T.r.md,background:`${T.gold}0E`,border:`1px solid ${T.gold}33`,marginBottom:22}}>
              <div style={{fontSize:10,fontWeight:500,color:T.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                What to do
              </div>
              <p style={{fontSize:13,color:T.text1,lineHeight:1.55}}>
                On your old device: tap your name → <span style={{fontStyle:"italic",fontFamily:T.serif}}>Full wipe</span>. That releases the name so you can claim it here.
              </p>
            </div>

            <button onClick={onClose} style={{width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text2}}>
              Got it
            </button>
          </>
        )}
      </div>
    </div>
  );
}
