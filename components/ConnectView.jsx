"use client";

// /connect — approve an AI's read access with Face ID. The name field is
// prefilled when this browser knows the profile; in Safari (separate from the
// home-screen app's storage) it's typed. The server decides which passkey
// consented; this page only relays the ceremony token.
import { useEffect, useRef, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { pressLiftHandlers } from "@/lib/press-lift";
import { P } from "@/lib/storage";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";

export default function ConnectView({ clientName, host, params }) {
  // The field is the truth. The name used to seed from localStorage during
  // render: the server rendered an empty name and a disabled button, the
  // browser rendered "Abrar", and hydration synced the input but kept the
  // server's disabled button — a filled field over a dead button
  // (2026-09-25). Now the name is read from the input at tap time (autofill
  // can also fill it without an event) and the button never disables on it.
  const [name, setName] = useState("");
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // Prefill after mount, not in the initial state: the server renders this
  // page, and a localStorage read during render would mismatch hydration.
  useEffect(() => {
    let known = "";
    try { known = P.getActive() || ""; } catch { /* storage blocked */ }
    if (known && !inputRef.current?.value) setName(known);
  }, []);
  const currentName = () => (inputRef.current?.value ?? name).trim();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const send = async (approve, authToken = null) => {
    const res = await fetchWithTimeout("/api/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken, profile: currentName(), params, approve }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.redirect) { window.location.assign(body.redirect); return true; }
    setError(body.error || "Something went wrong. Try again.");
    return false;
  };

  const onAllow = async () => {
    if (busy) return;
    const who = currentName();
    if (!who) { setError("Type your Heatwayve name first."); inputRef.current?.focus(); return; }
    if (who !== name) setName(who);
    setBusy(true); setError(null);
    try {
      const auth = await authenticatePasskey(who);
      if (!auth?.authToken) { setBusy(false); return; }   // cancelled
      if (!(await send(true, auth.authToken))) setBusy(false);
    } catch (e) {
      setError(e?.message === "WebAuthn not supported" ? "This browser can't use passkeys." : "Face ID didn't go through. Try again.");
      setBusy(false);
    }
  };

  const onDeny = async () => {
    if (busy) return;
    setBusy(true);
    if (!(await send(false))) setBusy(false);
  };

  return (
    <div style={{maxWidth:430,margin:"0 auto",fontFamily:T.text,color:T.ink,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px"}}>
      <div style={{fontSize:13,color:T.ink2,marginBottom:8}}>Connect your AI</div>
      <h1 style={{...DISPLAY,fontSize:38,color:T.ink,margin:"0 0 10px",overflowWrap:"anywhere"}}>{clientName} wants in</h1>
      <p style={{fontSize:14,color:T.ink2,marginBottom:6,lineHeight:1.6}}>
        It reads your training — lifts, volume, rhythm. Read only. Photos stay locked.
      </p>
      <p style={{fontSize:12,color:T.ink3,marginBottom:32,lineHeight:1.5}}>Returns to {host}</p>

      <label htmlFor="hw-connect-name" style={{display:"block",fontSize:13,color:T.ink3,marginBottom:6}}>Your Heatwayve name</label>
      <input id="hw-connect-name" ref={inputRef} value={name} onChange={e => setName(e.target.value)}
        autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy}
        style={{width:"100%",boxSizing:"border-box",height:48,padding:"0 14px",fontFamily:T.text,fontSize:16,color:T.ink,background:"transparent",border:`1px solid ${T.rule}`,borderRadius:T.r,marginBottom:20}}/>

      <button type="button" onClick={onAllow} aria-disabled={busy} className="forge-press forge-lift" {...pressLiftHandlers}
        style={{width:"100%",height:52,background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:15,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong,opacity:busy?0.6:1}}>
        {busy ? "One moment" : "Let it in"}
      </button>
      <button type="button" onClick={onDeny} disabled={busy}
        style={{width:"100%",height:44,marginTop:10,background:"none",border:"none",cursor:"pointer",fontFamily:T.text,fontSize:14,color:T.ink2}}>
        Not now
      </button>
      <div role="status" aria-live="polite" style={{fontSize:12,color:T.ink3,marginTop:10,minHeight:16,textAlign:"center"}}>{error || ""}</div>
    </div>
  );
}
