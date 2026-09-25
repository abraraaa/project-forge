"use client";

// /profile/coach — AI coaching. Connect an AI (Claude via its prefilled
// link, the rest by pasting ours), see and end connections, or hand any chat
// a snapshot.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { T, DISPLAY } from "@/lib/tokens";
import { pressLiftHandlers } from "@/lib/press-lift";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import ErrorBoundary from "@/components/ErrorBoundary";
import { P } from "@/lib/storage";
import { withNavTransition } from "@/lib/nav-transitions";
import { copyCoachContext } from "@/lib/coach-share";
import { CONNECT_OPTIONS, MCP_URL, ago } from "@/lib/coach-connect";
import { fetchWithTimeout } from "@/lib/net";

/** @returns {Promise<any[] | null>} null when the server won't say (no sign-in, offline). */
async function fetchConnections(profile) {
  try {
    const res = await fetchWithTimeout(`/api/sync/connections?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.connections) ? body.connections : [];
  } catch { return null; }
}

export default function CoachView() {
  const router = useRouter();
  const [current] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [copied, setCopied] = useState(null);

  const [pick, setPick] = useState("claude");
  const option = CONNECT_OPTIONS.find((o) => o.id === pick) || CONNECT_OPTIONS[0];
  const [linkCopied, setLinkCopied] = useState(false);
  const onCopyLink = async () => {
    try { await navigator.clipboard.writeText(MCP_URL); setLinkCopied(true); } catch { setLinkCopied(false); }
  };

  // Connected AIs — shown only when the server answers (a profile without a
  // passkey has no sync sign-in, and nothing to list).
  const [connections, setConnections] = useState(null);
  const [busyId, setBusyId] = useState(null);
  useEffect(() => {
    if (!current) return undefined;
    let off = false;
    fetchConnections(current).then((list) => { if (!off && list) setConnections(list); });
    return () => { off = true; };
  }, [current]);
  const onDisconnect = async (id) => {
    setBusyId(id);
    try {
      await fetchWithTimeout("/api/sync/connections", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: current, disconnect: id }),
      });
    } catch { /* the reload shows the truth either way */ }
    const list = await fetchConnections(current);
    if (list) setConnections(list);
    setBusyId(null);
  };

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
          <div style={{padding:"18px 2px",borderTop:`1px solid ${T.rule}`,borderBottom:`1px solid ${T.rule}`}}>
            <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Connect your AI</div>
            <div style={{fontSize:12,color:T.ink3,marginTop:4,lineHeight:1.5,marginBottom:14}}>
              It reads your training as it happens — read only, photos stay locked.
            </div>
            <label htmlFor="hw-connect-ai" style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0 0 0 0)"}}>Your AI</label>
            <div style={{position:"relative",marginBottom:12}}>
              <select id="hw-connect-ai" value={pick} onChange={(e) => { setPick(e.target.value); setLinkCopied(false); }}
                style={{width:"100%",height:48,appearance:"none",WebkitAppearance:"none",padding:"0 40px 0 14px",fontFamily:T.text,fontSize:16,color:T.ink,background:"transparent",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer"}}>
                {CONNECT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <span aria-hidden="true" style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%) rotate(90deg)",pointerEvents:"none",display:"flex"}}>
                <Glyph name="arrowRight" size={12} color={T.ink3}/>
              </span>
            </div>
            {option.action === "open" ? (
              <a href={option.href} target="_blank" rel="noopener noreferrer" className="forge-press forge-lift" {...pressLiftHandlers}
                style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,width:"100%",height:52,background:T.commit,borderRadius:T.r,fontFamily:T.text,fontSize:15,fontWeight:500,color:T.commitInk,textDecoration:"none",boxShadow:T.elevStrong,boxSizing:"border-box"}}>
                <span>{option.cta}</span><Glyph name="arrowUpRight" size={13} color={T.commitInk}/>
              </a>
            ) : (
              <button type="button" onClick={onCopyLink} className="forge-press forge-lift" {...pressLiftHandlers}
                style={{width:"100%",height:52,background:T.commit,border:"none",borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:15,fontWeight:500,color:T.commitInk,boxShadow:T.elevStrong}}>
                {linkCopied ? "Copied" : option.cta}
              </button>
            )}
            <ol style={{margin:"14px 0 0",paddingLeft:18,fontSize:12,color:T.ink2,lineHeight:1.6}}>
              {option.steps.map((st) => <li key={st}>{st}</li>)}
            </ol>
            <div style={{fontSize:11,color:T.ink3,marginTop:10,fontFamily:T.measured,overflowWrap:"anywhere"}}>{MCP_URL}</div>
          </div>
        </Fade>

        {connections && (
          <Fade d={110}>
            <div style={{padding:"16px 2px",borderBottom:`1px solid ${T.rule}`}}>
              <div style={{fontSize:13,color:T.ink3,marginBottom:connections.length ? 6 : 0}}>
                {connections.length ? "Connected" : "Nothing connected yet."}
              </div>
              {connections.map((c) => (
                <div key={c.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"8px 0"}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:15,color:T.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</div>
                    <div style={{fontSize:12,color:T.ink3}}>{c.lastRead ? `Read ${ago(c.lastRead)}` : "Not used yet"}</div>
                  </div>
                  <button type="button" onClick={() => onDisconnect(c.id)} disabled={busyId === c.id} className="forge-press forge-tint"
                    style={{flexShrink:0,height:36,padding:"0 12px",background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:13,color:T.ink2}}>
                    {busyId === c.id ? "…" : "Disconnect"}
                  </button>
                </div>
              ))}
            </div>
          </Fade>
        )}

        <Fade d={140}>
          <div style={{padding:"18px 2px",borderBottom:`1px solid ${T.rule}`}}>
            <div style={{fontSize:15,fontWeight:500,color:T.ink}}>Hand it the story</div>
            <div style={{fontSize:12,color:T.ink3,marginTop:4,lineHeight:1.5,marginBottom:14}}>
              Lifts, volume, rhythm — in one copy. A snapshot: it sees today, not tomorrow.
            </div>
            {/* Quiet: Connect holds the one commit surface on this screen. */}
            <button type="button" onClick={onCopy} className="forge-press forge-tint"
              style={{width:"100%",height:52,background:"none",border:`1px solid ${T.rule}`,borderRadius:T.r,cursor:"pointer",fontFamily:T.text,fontSize:15,fontWeight:500,color:T.ink}}>
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
