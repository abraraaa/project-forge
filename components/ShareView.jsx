"use client";

// components/ShareView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// /share: where a trainer's link or QR lands, usually in Safari rather than
// the installed app. It shows the code with the steps to enter it in the app
// (Profile, then Add a trainer), and a "Copy code" to carry it across. When
// this browser is already signed in, the approval can be finished here too.
//
// The code arrives in the URL fragment, which never reaches the server. It is
// read once on mount and the fragment is dropped from the address bar. The
// code lives in React state only; the one storage read is P.getActive(), for
// the signed-in name.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { Fade } from "@/components/ui";
import ErrorBoundary from "@/components/ErrorBoundary";
import ShareApprove from "@/components/ShareApprove";
import { P } from "@/lib/storage";
import { fetchWithTimeout } from "@/lib/net";
import { normaliseCode, formatCode } from "@/lib/trainer-code";

export const SHARE_PAGE_COPY = Object.freeze({
  kicker: "Share with your trainer",
  anyone: "Your trainer's code",
  steps: Object.freeze([
    "Open Heatwayve.",
    "Go to Profile, then Add a trainer.",
    "Paste or type the code, and approve with Face ID.",
  ]),
  copy: "Copy code",
  copied: "Copied",
  copyFailed: "Couldn't reach the clipboard. Try again.",
  noCode: "Got a code?",
  noCodeLine: "Type it in the app: Profile, then Add a trainer.",
  miss: "That code didn't work. Check it, or ask your trainer for a fresh one.",
});

// The fragment as typed: a spaced or "·" code arrives percent-encoded.
function fragment() {
  const h = window.location.hash;
  try { return decodeURIComponent(h); } catch { return h; }
}

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } };

/**
 * Whose code this is. Peek confers nothing and needs no sign-in.
 * @param {string} code
 * @returns {Promise<{ name: string } | { miss: true } | null>} null when offline.
 */
async function peekCode(code) {
  try {
    const res = await fetchWithTimeout("/api/share/peek", { ...JSON_POST, body: JSON.stringify({ code }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body?.trainer?.name === "string") return { name: body.trainer.name };
    return res.status === 404 ? { miss: true } : null;
  } catch {
    return null;
  }
}

/**
 * Whether this browser is signed in as `profile` (its hw_sync cookie) and may
 * add a trainer: the same status check Profile makes.
 * @param {string} profile
 */
async function canShareHere(profile) {
  try {
    const res = await fetchWithTimeout(`/api/sync/trainer?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.open === true;
  } catch {
    return false;
  }
}

export default function ShareView() {
  // Read once, before the fragment is dropped below.
  const [code] = useState(() => (typeof window === "undefined" ? null : normaliseCode(fragment())));
  const [me] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [trainer, setTrainer] = useState(/** @type {{ name: string } | { miss: true } | null} */ (null));
  const [signedIn, setSignedIn] = useState(false);
  const [copied, setCopied] = useState(/** @type {"ok" | "fail" | null} */ (null));

  // The code stays out of the address bar, history and anything that reads the URL later.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", "/share");
  }, []);

  useEffect(() => {
    if (!code) return undefined;
    let off = false;
    peekCode(code).then((r) => { if (!off) setTrainer(r); });
    return () => { off = true; };
  }, [code]);

  useEffect(() => {
    if (!code || !me) return undefined;
    let off = false;
    canShareHere(me).then((ok) => { if (!off) setSignedIn(ok); });
    return () => { off = true; };
  }, [code, me]);

  const onCopy = async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); setCopied("ok"); } catch { setCopied("fail"); }
  };

  const name = trainer && "name" in trainer ? trainer.name : null;
  const miss = !!trainer && "miss" in trainer;
  const kicker = <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>{SHARE_PAGE_COPY.kicker}</div>;
  const h1 = (text) => <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 18px", overflowWrap: "anywhere" }}>{text}</h1>;
  const steps = (
    <ol aria-label="In the app" style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: T.ink, lineHeight: 1.7 }}>
      {SHARE_PAGE_COPY.steps.map((s) => <li key={s}>{s}</li>)}
    </ol>
  );

  return (
    <ErrorBoundary>
      <div style={{ background: "transparent", maxWidth: 430, margin: "0 auto", fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased", padding: "72px 24px 48px" }}>
        {code ? (
          <>
            <Fade d={0} opaque>
              {kicker}
              {h1(name ? `${name}'s code` : SHARE_PAGE_COPY.anyone)}
              <div style={{ padding: "18px 2px", borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}` }}>
                <div style={{ fontFamily: T.measured, fontSize: 22, letterSpacing: "0.06em", color: T.ink, userSelect: "all", WebkitUserSelect: "all", marginBottom: 14 }}>
                  {formatCode(code)}
                </div>
                {/* Quiet: the approval below, when there is one, holds the commit. */}
                <button type="button" onClick={onCopy} className="forge-press forge-tint"
                  style={{ width: "100%", height: 48, background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink }}>
                  {copied === "ok" ? SHARE_PAGE_COPY.copied : SHARE_PAGE_COPY.copy}
                </button>
                <div role="status" aria-live="polite" style={{ fontSize: 12, color: T.ink2, marginTop: 10, minHeight: 16, lineHeight: 1.5 }}>
                  {miss ? SHARE_PAGE_COPY.miss : copied === "fail" ? SHARE_PAGE_COPY.copyFailed : ""}
                </div>
              </div>
            </Fade>
            <Fade d={80}>
              <div style={{ padding: "18px 2px 0" }}>{steps}</div>
            </Fade>
            {signedIn && name && (
              <Fade d={0}>
                <div style={{ marginTop: 36, paddingTop: 22, borderTop: `1px solid ${T.rule}` }}>
                  <div style={{ fontSize: 13, color: T.ink2, marginBottom: 14, overflowWrap: "anywhere" }}>Or share from here, as {me}</div>
                  <ShareApprove name={me} code={code} level={2} />
                </div>
              </Fade>
            )}
          </>
        ) : (
          <Fade d={0} opaque>
            {kicker}
            {h1(SHARE_PAGE_COPY.noCode)}
            <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 18px" }}>{SHARE_PAGE_COPY.noCodeLine}</p>
            {steps}
          </Fade>
        )}
      </div>
    </ErrorBoundary>
  );
}
