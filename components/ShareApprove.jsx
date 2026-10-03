"use client";

// components/ShareApprove.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The one place a client approves a trainer: in Profile, and on /share when
// that browser is signed in. Type or paste the code (or a whole share link),
// see whose it is and what they'll see, then approve with Face ID.
//
// `name` is the client's Heatwayve name, from the caller; it is read when
// Share is tapped and never typed here. The code lives in React state only.
// The ceremony is quiet (no lifter cookies), and its token is kept in memory
// just long enough to resend after "Switch", so switching costs no second
// Face ID.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { pressLiftHandlers } from "@/lib/press-lift";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";
import { normaliseCode, formatCode } from "@/lib/trainer-code";
import { SHARE_COPY, SHARE_CONSENT_VERSION } from "@/lib/trainer-terms";

export const APPROVE_COPY = Object.freeze({
  label: "The code your trainer showed you",
  hint: "Letters and numbers. Paste it, or type it with or without spaces.",
  next: "Next",
  miss: "That code didn't work. Check it, or ask your trainer for a fresh one.",
  faceId: "Face ID didn't go through. Try again.",
  noPasskeys: "This browser can't use passkeys.",
  self: "That's your own code.",
  native: "This needs a passkey for heatwayve.app first.",
  tooMany: "Too many tries. Ask your trainer for a fresh code, then try again in an hour.",
  slowDown: "Too many tries. Wait a minute and try again.",
  stale: "This page is out of date. Reload and try again.",
  offline: "Couldn't reach Heatwayve. Try again.",
  changed: "Something changed. Try again.",
  notNow: "Not now",
  done: "Done",
  doneLine: "Read only. Stop any time in Profile.",
});

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } };

// What the field shows while typing: the same folding as normaliseCode, then
// groups of four. A pasted link keeps only its code.
function tidy(s) {
  const hash = s.indexOf("#");
  const c = (hash >= 0 ? s.slice(hash + 1) : s)
    .normalize("NFKC").toUpperCase()
    .replace(/[\s·.-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return formatCode(c);
}

/**
 * Who a code names. Peek confers nothing and never counts against the
 * client's tries.
 * @param {string} c
 * @returns {Promise<{ name: string } | { error: string }>}
 */
async function peekCode(c) {
  try {
    const res = await fetchWithTimeout("/api/share/peek", { ...JSON_POST, body: JSON.stringify({ code: c }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body?.trainer?.name === "string") return { name: body.trainer.name };
    if (res.status === 429) return { error: APPROVE_COPY.slowDown };
    return { error: res.status === 404 ? APPROVE_COPY.miss : body?.error || APPROVE_COPY.miss };
  } catch {
    return { error: APPROVE_COPY.offline };
  }
}

/**
 * @param {{ name: string, code?: string | null, title?: string, lead?: import("react").ReactNode,
 *   level?: 1 | 2, onApproved?: () => void, onDone?: () => void, onCancel?: () => void }} props
 *   code: a code already in hand (the /share link); the field is hidden.
 *   title: the heading over the code field; lead: a line between it and the
 *   field. level: 1 when this is the page's heading, 2 when it sits under
 *   another. onApproved: the share is live. onDone: "Done" after approval.
 *   onCancel: "Not now" on the approve step.
 */
export default function ShareApprove({ name, code = null, title, lead = null, level = 1, onApproved, onDone, onCancel }) {
  const given = code ? normaliseCode(code) : null;
  const [raw, setRaw] = useState("");
  const [peeking, setPeeking] = useState(!!given);
  const [fieldError, setFieldError] = useState(/** @type {string | null} */ (null));
  const [phase, setPhase] = useState(/** @type {"code" | "approve" | "switch" | "done"} */ ("code"));
  const [trainer, setTrainer] = useState(/** @type {{ name: string, code: string } | null} */ (null));
  const [replaces, setReplaces] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  // The newest code peeked; an older answer arriving late is dropped.
  const lastPeek = useRef(/** @type {string | null} */ (null));
  // The ceremony token, held only between a 409 "replaces" and "Switch".
  const tokenRef = useRef(/** @type {string | null} */ (null));
  // Which element takes focus when a tap moves to a new step, so keyboard
  // and screen-reader users land on the change: the step's heading, the
  // switch question, Share (back from switch) or the field (back to the code).
  const focusNext = useRef(/** @type {"approve" | "switch" | "share" | "done" | "field" | null} */ (null));
  const takeFocus = (target) => (el) => {
    if (el && focusNext.current === target) { focusNext.current = null; el.focus(); }
  };

  const applyPeek = (c, r) => {
    if (lastPeek.current !== c) return;
    setPeeking(false);
    if ("name" in r) {
      setTrainer({ name: r.name, code: c });
      setError(null);
      focusNext.current = "approve";
      setPhase("approve");
    } else {
      setFieldError(r.error);
    }
  };
  const peek = (c) => {
    lastPeek.current = c;
    setPeeking(true);
    setFieldError(null);
    peekCode(c).then((r) => applyPeek(c, r));
  };

  // A code from the link: say whose it is, once.
  useEffect(() => {
    if (!given) return undefined;
    let off = false;
    lastPeek.current = given;
    peekCode(given).then((r) => {
      if (off) return;
      setPeeking(false);
      if ("name" in r) { setTrainer({ name: r.name, code: given }); setPhase("approve"); }
      else setFieldError(r.error);
    });
    return () => { off = true; };
  }, [given]);

  const onInput = (e) => {
    const text = e.target.value;
    setRaw(tidy(text));
    setFieldError(null);
    const c = normaliseCode(text);
    if (!c) { lastPeek.current = null; setPeeking(false); return; }
    if (c !== lastPeek.current) peek(c);
  };
  const typed = normaliseCode(raw);

  const approve = async (replace = false) => {
    if (busy || !trainer) return;
    setBusy(true);
    setError(null);
    let token = replace ? tokenRef.current : null;
    if (!token) {
      try {
        const auth = await authenticatePasskey(name, { quiet: true });
        token = auth?.authToken || null;
      } catch (e) {
        setError(e?.message === "WebAuthn not supported" ? APPROVE_COPY.noPasskeys : APPROVE_COPY.faceId);
        setBusy(false);
        return;
      }
      // Cancelled: back to where they were, nothing said.
      if (!token) { setBusy(false); return; }
    }
    tokenRef.current = null;
    let res, body;
    try {
      res = await fetchWithTimeout("/api/share/approve", {
        ...JSON_POST,
        body: JSON.stringify({
          code: trainer.code, authToken: token, profile: name,
          consent: { version: SHARE_CONSENT_VERSION },
          ...(replace ? { replace: true } : null),
        }),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      setError(APPROVE_COPY.offline);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (res.ok && body?.ok) { focusNext.current = "done"; setPhase("done"); onApproved?.(); return; }
    if (res.status === 409 && typeof body?.replaces?.name === "string") {
      tokenRef.current = token;
      focusNext.current = "switch";
      setReplaces(body.replaces.name);
      setPhase("switch");
      return;
    }
    if (res.status === 404 && !given) {
      // Used or expired since the peek: back to the field, text kept.
      lastPeek.current = trainer.code;
      focusNext.current = "field";
      setFieldError(APPROVE_COPY.miss);
      setPhase("code");
      return;
    }
    if (phase === "switch") focusNext.current = "share";
    setPhase("approve");
    setError(
      res.status === 404 ? APPROVE_COPY.miss
      : res.status === 401 ? APPROVE_COPY.faceId
      // The hourly miss gate brings its own line; the per-IP limiter does not.
      : res.status === 429 ? (body?.error === APPROVE_COPY.tooMany ? APPROVE_COPY.tooMany : APPROVE_COPY.slowDown)
      : body?.self ? APPROVE_COPY.self
      : body?.needsNativePasskey ? APPROVE_COPY.native
      : body?.stale ? APPROVE_COPY.stale
      : body?.error || APPROVE_COPY.changed,
    );
  };

  const keep = () => { tokenRef.current = null; setReplaces(null); focusNext.current = "share"; setPhase("approve"); };

  const wrap = { fontFamily: T.text, color: T.ink };
  const commitStyle = { width: "100%", height: 52, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong };
  const quietStyle = { width: "100%", height: 44, marginTop: 10, background: "none", border: "none", cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink2 };
  const statusStyle = { fontSize: 12, color: T.ink2, marginTop: 10, minHeight: 16, lineHeight: 1.5 };
  const H = level === 2 ? "h2" : "h1";
  // Keyed by step, so each step's heading is a new element and can take focus.
  // Back at the code step the field takes it, with the reason it describes.
  const heading = (text, margin, step) => (
    <H key={step} ref={takeFocus(step)} tabIndex={-1}
      style={{ ...DISPLAY, fontSize: level === 2 ? 30 : 38, color: T.ink, margin, overflowWrap: "anywhere", outline: "none" }}>{text}</H>
  );

  if (phase === "done" && trainer) {
    return (
      <div style={wrap}>
        {heading(`${trainer.name} can see your training.`, "0 0 10px", "done")}
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 24px" }}>{APPROVE_COPY.doneLine}</p>
        {onDone && (
          <button type="button" onClick={onDone} className="forge-press forge-tint"
            style={{ width: "100%", height: 52, background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink }}>
            {APPROVE_COPY.done}
          </button>
        )}
      </div>
    );
  }

  if ((phase === "approve" || phase === "switch") && trainer) {
    return (
      <div style={wrap}>
        {heading(`${trainer.name} wants to see your training`, "0 0 18px", "approve")}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, borderTop: `1px solid ${T.rule}` }}>
          {SHARE_COPY.rows.map((row) => (
            <li key={row} style={{ padding: "12px 2px", borderBottom: `1px solid ${T.rule}`, fontSize: 14, color: T.ink, lineHeight: 1.5 }}>{row}</li>
          ))}
        </ul>
        <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6, margin: "14px 0 24px" }}>{SHARE_COPY.includes}</p>

        {phase === "switch" && replaces ? (
          <div role="group" aria-labelledby="share-switch">
            <p id="share-switch" ref={takeFocus("switch")} tabIndex={-1} style={{ fontSize: 15, color: T.ink, lineHeight: 1.5, margin: "0 0 14px", outline: "none" }}>
              You share with {replaces} now. Switch to {trainer.name}?
            </p>
            <button type="button" onClick={() => approve(true)} aria-disabled={busy} aria-describedby="share-line"
              className="forge-press forge-lift" {...pressLiftHandlers}
              style={{ ...commitStyle, opacity: busy ? 0.6 : 1 }}>
              {busy ? "One moment" : "Switch"}
            </button>
            {/* Switch is the approval here, so the statement sits under it too. */}
            <p id="share-line" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "12px 0 0" }}>{SHARE_COPY.line}</p>
            <button type="button" onClick={keep} disabled={busy} style={quietStyle}>Keep {replaces}</button>
          </div>
        ) : (
          <>
            {!given && (
              <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "0 0 12px" }}>You&apos;ll approve as {name} with Face ID.</p>
            )}
            <button type="button" ref={takeFocus("share")} onClick={() => approve(false)} aria-disabled={busy} aria-describedby="share-line"
              className="forge-press forge-lift" {...pressLiftHandlers}
              style={{ ...commitStyle, opacity: busy ? 0.6 : 1 }}>
              {busy ? "One moment" : `Share with ${trainer.name}`}
            </button>
            {/* ConsentLine grammar: the statement sits under the commit it describes. */}
            <p id="share-line" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "12px 0 0" }}>{SHARE_COPY.line}</p>
            {onCancel && <button type="button" onClick={onCancel} disabled={busy} style={quietStyle}>{APPROVE_COPY.notNow}</button>}
          </>
        )}
        <div role="status" aria-live="polite" style={statusStyle}>{error || ""}</div>
      </div>
    );
  }

  // A code from the link: no field, just whose it is (or why not).
  if (given) {
    return (
      <div style={wrap}>
        <div role="status" aria-live="polite" style={statusStyle}>{peeking ? "One moment" : fieldError || ""}</div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      {title && heading(title, "0 0 14px", "code")}
      {lead}
      <label htmlFor="hw-share-code" style={{ display: "block", fontSize: 13, color: T.ink2, marginBottom: 6 }}>{APPROVE_COPY.label}</label>
      <input id="hw-share-code" ref={takeFocus("field")} value={raw} onChange={onInput} aria-describedby="hw-share-code-hint hw-share-code-status"
        autoCapitalize="characters" autoCorrect="off" spellCheck={false} inputMode="text" autoComplete="off"
        style={{ width: "100%", boxSizing: "border-box", height: 48, padding: "0 14px", fontFamily: T.measured, fontSize: 16, letterSpacing: "0.04em", color: T.ink, background: "transparent", border: `1px solid ${T.rule}`, borderRadius: T.r }}/>
      <p id="hw-share-code-hint" style={{ fontSize: 12, color: T.ink2, lineHeight: 1.5, margin: "8px 0 0" }}>{APPROVE_COPY.hint}</p>
      <div id="hw-share-code-status" role="status" aria-live="polite" style={{ ...statusStyle, marginTop: 6, marginBottom: 14 }}>{fieldError || ""}</div>
      <button type="button" onClick={() => typed && peek(typed)} disabled={!typed || peeking}
        className="forge-press forge-lift" {...pressLiftHandlers}
        style={{ ...commitStyle, cursor: typed && !peeking ? "pointer" : "default", opacity: typed && !peeking ? 1 : 0.5 }}>
        {peeking ? "One moment" : APPROVE_COPY.next}
      </button>
    </div>
  );
}
