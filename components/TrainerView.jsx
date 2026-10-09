"use client";

// components/TrainerView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// /trainer: the trainer's dashboard. Signed out it asks for a Heatwayve name
// and a quiet Face ID (no lifter cookies are left on this device). Someone
// who isn't a trainer applies here; the admin sets up directly, and a trainer
// accepts changed Trainer Terms here. Signed in it lists the clients who
// share with them under the trainer's own training (the "You" row), opens one
// at a time in the pane, and shows an invite code. For a client who has the
// trainer's changes on, the pane sends plan changes through
// /api/trainer/change; a send needs a Face ID within the day, so the pane can
// ask for one here.
//
// Layout is the wide shell (.forge-wide in globals.css): the roster column
// and the client pane, one at a time under 640. The URL stays /trainer;
// opening a client pushes a history entry with only a list index in it, so
// grant ids never reach the address bar, history or analytics. The trainer's
// name lives in memory only.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { T, DISPLAY } from "@/lib/tokens";
import { withNavTransition } from "@/lib/nav-transitions";
import { pressLiftHandlers } from "@/lib/press-lift";
import { useInlineModalA11y } from "@/lib/a11y";
import Glyph from "@/components/Glyph";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";
import { todayLocalIso } from "@/lib/dates";
import { formatCode, shareUrl } from "@/lib/trainer-code";
import { TRAINER_TERMS_COPY, TRAINER_TERMS_VERSION } from "@/lib/trainer-terms";
import {
  APPLY_COPY, REPLY_COPY, ABOUT_MAX, ABOUT_COUNT_FROM, LINK_MAX, aboutProblem, deniedLine, linkProblem, linkToSend, toMs,
} from "@/lib/trainer-apply-copy";
import { SELF_REF } from "@/lib/trainer-view";
import TrainerClientView, { Nums, msDayMonth } from "@/components/TrainerClientView";
import QrCode from "@/components/QrCode";

const POLL_MS = 3000;
const POLL_FOR_MS = 20 * 60_000;
// A ceremony token is good for 5 minutes at the routes; reuse it inside 4.
const CEREMONY_REUSE_MS = 4 * 60_000;
const FACE_ID_FAILED = "Face ID didn't go through. Try again.";
// A share link is a 37-module symbol with its quiet zone: 5 px a module.
const QR_PX = 185;
// The trainer's own training: the roster's pinned first row. Its history
// entry says self rather than holding an index.
const SELF_ROW = Object.freeze({ ref: SELF_REF, name: null, lastLooked: null });
/** @param {HTMLElement | null} el */
const focusOnMount = (el) => { el?.focus(); };

/** JSON in, { status, body } out; status 0 when the network failed. */
async function call(path, body) {
  try {
    const res = await fetchWithTimeout(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, body: {} };
  }
}

/** The CSV request: the pane reads the Response itself (body, filename). Network failure is null. */
const exportCsv = (body) => fetchWithTimeout("/api/trainer/export", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).catch(() => null);

/**
 * The words for a reply with none of its own. The server's text is never shown.
 * @param {{ status: number }} r
 */
function replyError(r) {
  if (r.status === 0) return REPLY_COPY.offline;
  if (r.status === 429) return REPLY_COPY.tooMany;
  if (r.status === 401) return FACE_ID_FAILED;
  return REPLY_COPY.wentWrong;
}

/**
 * Which 503 the apply route sent: the queue cap, before launch, or neither
 * (an outage, which reads as something went wrong).
 * @param {{ body: any }} r
 * @returns {"paused" | "notOpen" | null}
 */
const applyClosed = (r) => {
  const said = String(r.body.error ?? "");
  if (r.body.paused === true || /paused/i.test(said)) return "paused";
  if (r.body.notOpen === true || /not open/i.test(said)) return "notOpen";
  return null;
};

/**
 * What /trainer shows for an application the server already holds, or null
 * for the form (none, withdrawn, or a denial whose wait is over).
 * @param {any} app
 * @returns {{ kind: "applied" | "denied", nextAt?: number | null } | null}
 */
function resultFor(app) {
  if (app?.status === "applied") return { kind: "applied" };
  const next = toMs(app?.nextAt);
  if (app?.status === "denied" && next != null && next > Date.now()) return { kind: "denied", nextAt: next };
  return null;
}

/**
 * A roster line: "Last trained 2 days ago · 2 of 3 this week · rhythm 86%".
 * Paused clients show no week count or rhythm. With no signal (the roster
 * look could not be logged) only the sharing date shows.
 * @param {any} signal
 * @param {number | null} since
 */
export function signalText(signal, since) {
  if (!signal) return since ? `Sharing since ${msDayMonth(since)}` : "Sharing with you";
  const d = signal.lastTrainedDaysAgo;
  const last = d == null ? "No sessions in the last year"
    : d === 0 ? "Trained today"
    : d === 1 ? "Last trained yesterday"
    : `Last trained ${d} days ago`;
  if (signal.paused) return `${last} · paused`;
  if (d == null) return last;
  const parts = [last];
  if (signal.weekPlanned > 0) parts.push(`${signal.weekDone} of ${signal.weekPlanned} this week`);
  if (signal.rhythmPct != null) parts.push(`rhythm ${signal.rhythmPct}%`);
  return parts.join(" · ");
}

/** "14:32", the device's own clock. @param {number} ms */
function clockTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** @type {import("react").CSSProperties} */
const commitBtn = {
  width: "100%", height: 52, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong,
};
/** @type {import("react").CSSProperties} */
const quietBtn = {
  height: 44, padding: "0 16px", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r,
  cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink2,
};
/** @type {import("react").CSSProperties} */
const linkBtn = {
  background: "none", border: "none", padding: "8px 0", cursor: "pointer",
  fontFamily: T.text, fontSize: 13, color: T.ink2,
};
/** The house back row, as Profile's "← Home". @type {import("react").CSSProperties} */
const backRow = {
  background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2,
  marginBottom: 32, display: "inline-flex", alignItems: "center", gap: 5,
};
/** @type {import("react").CSSProperties} */
const kickerStyle = { fontSize: 13, color: T.ink3, marginBottom: 8 };
/** @type {import("react").CSSProperties} */
const h1Style = { ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 10px", overflowWrap: "anywhere" };
/** A roster row's button. @param {boolean} current @returns {import("react").CSSProperties} */
const rowStyle = (current) => ({
  display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 8px", background: current ? T.press : "none",
  border: "none", borderRadius: T.rSm, cursor: "pointer", textAlign: "left", fontFamily: T.text, color: T.ink,
});
/** @type {import("react").CSSProperties} */
const rowTitle = { display: "block", fontSize: 15, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/** @type {import("react").CSSProperties} */
const rowLine = { display: "block", fontSize: 12, color: T.ink3, marginTop: 3, lineHeight: 1.45 };

export default function TrainerView() {
  const router = useRouter();
  // loading · signedOut · apply (not a trainer yet) · upgrade (the admin, not a
  // trainer yet) · terms (terms changed) · error · roster
  const [phase, setPhase] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notOpen, setNotOpen] = useState(false);
  const [legacy, setLegacy] = useState(false);
  // The name typed at sign-in; never written to the device.
  const [who, setWho] = useState("");
  const nameRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // The last quiet ceremony: reused once for the upgrade or the application,
  // so it costs one Face ID.
  const ceremony = useRef(/** @type {{ name: string, token: string, at: number } | null} */ (null));
  // The application being written (memory only; kept across a sign-in bounce)
  // and what came back: { kind: 'sent' | 'applied' | 'denied', nextAt }.
  const [about, setAbout] = useState("");
  const [link, setLink] = useState("");
  const [applyResult, setApplyResult] = useState(/** @type {{ kind: string, nextAt?: number | null } | null} */ (null));

  const [me, setMe] = useState(null);
  const [clients, setClients] = useState([]);
  const [loadedAt, setLoadedAt] = useState(0);
  // The open client (or SELF_ROW, i -1): { i, ref, name, lastLooked } and its pane state.
  const [open, setOpen] = useState(null);
  const [pane, setPane] = useState(null); // { ref, state: 'loading' | 'missing' | 'error' } | { ref, state: 'ready', client, view, self }
  const mainRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  // Only the latest pane request may fill the pane; an earlier reply that
  // lands late is dropped.
  const paneSeq = useRef(0);
  // Reloads of the open pane after a change, in order among themselves.
  const refreshSeq = useRef(0);
  // The client the history entry was made for; its index can point elsewhere
  // once the roster reloads.
  const entryRef = useRef(/** @type {string | null} */ (null));

  const [invite, setInvite] = useState(null); // { code, expiresAt, issuedAt } | { error } | { issuing: true }
  // Only the latest issue may fill the sheet; closing it drops any reply still out.
  const inviteSeq = useRef(0);

  const reset = () => {
    setMe(null); setClients([]); setOpen(null); setPane(null); setInvite(null); setApplyResult(null);
    ceremony.current = null; paneSeq.current += 1; inviteSeq.current += 1; entryRef.current = null;
  };

  // The terms changed under an open session: no client stays half-open, so
  // the roster comes back clean once they agree again.
  const toTerms = () => {
    paneSeq.current += 1; entryRef.current = null;
    setOpen(null); setPane(null);
    if (window.history.state?.view === "client") window.history.replaceState({}, "");
    setPhase("terms");
  };

  const fetchRoster = () => call("/api/trainer/clients", { today: todayLocalIso() });
  const applyRoster = (r) => {
    if (r.status === 200) {
      setMe(r.body.me?.name ?? null);
      setClients(Array.isArray(r.body.clients) ? r.body.clients : []);
      setLoadedAt(Date.now());
      setPhase("roster");
    } else if (r.status === 401) {
      reset(); setPhase("signedOut");
    } else if (r.status === 403 && r.body.needsTerms) {
      toTerms();
    } else if (phase !== "roster") {
      setPhase("error");
    }
  };
  const loadRoster = async () => applyRoster(await fetchRoster());
  const onFirstRoster = useEffectEvent(applyRoster);
  useEffect(() => {
    let off = false;
    fetchRoster().then((r) => { if (!off) onFirstRoster(r); });
    return () => { off = true; };
  }, []);

  // ── Sign-in, the application and the upgrade ──────────────────────────────

  const typedName = () => (nameRef.current?.value ?? who).trim();

  /** A quiet passkey ceremony for `name`; null when cancelled or failed (error shown). */
  const runCeremony = async (name) => {
    try {
      const auth = await authenticatePasskey(name, { quiet: true });
      if (!auth?.authToken) return null;
      ceremony.current = { name, token: auth.authToken, at: Date.now() };
      return ceremony.current;
    } catch (e) {
      setError(e?.message === "WebAuthn not supported" ? "This browser can't use passkeys." : FACE_ID_FAILED);
      return null;
    }
  };

  const signIn = async () => {
    if (busy) return;
    const name = typedName();
    if (!name) { setError("Type your Heatwayve name first."); nameRef.current?.focus(); return; }
    setWho(name); setBusy(true); setError(null); setNotOpen(false); setLegacy(false);
    const c = await runCeremony(name);
    if (!c) { setBusy(false); return; }
    const r = await call("/api/trainer/session", { authToken: c.token, profile: c.name });
    setBusy(false);
    if (r.status === 200) {
      ceremony.current = null;
      if (typeof r.body.name === "string") setMe(r.body.name);
      await loadRoster();
      return;
    }
    // The panels name the trainer as clients see them: the server's name.
    if (r.status === 403 && typeof r.body.name === "string") setMe(r.body.name);
    // Not a trainer: the admin sets up directly; everyone else applies, or
    // sees where their application stands.
    if (r.status === 403 && r.body.notTrainer) {
      if (r.body.admin === true) { setPhase("upgrade"); return; }
      setApplyResult(resultFor(r.body.application));
      setPhase("apply");
      return;
    }
    if (r.status === 403 && r.body.needsTerms) { setPhase("terms"); return; }
    if (r.status === 409 && r.body.needsNativePasskey) { setLegacy(true); return; }
    if (r.status === 503) { setNotOpen(true); return; }
    ceremony.current = null;
    setError(replyError(r));
  };

  // "Send application": the fields are checked first, then one quiet Face ID
  // (sign-in's, while fresh). Tapping is the acceptance: 18+ and the current
  // Trainer Terms ride in the body, as for the upgrade.
  const sendApplication = async () => {
    if (busy) return;
    const bad = aboutProblem(about) || linkProblem(link);
    if (bad) { setError(bad); return; }
    const text = about.trim();
    const url = linkToSend(link);
    const fresh = ceremony.current && Date.now() - ceremony.current.at < CEREMONY_REUSE_MS ? ceremony.current : null;
    const name = fresh?.name || typedName();
    if (!name) { setError("Type your Heatwayve name first."); nameRef.current?.focus(); return; }
    setWho(name); setBusy(true); setError(null); setNotOpen(false); setLegacy(false);
    const c = fresh || await runCeremony(name);
    if (!c) { setBusy(false); return; }
    const r = await call("/api/trainer/apply", {
      authToken: c.token, profile: c.name, about: text, ...(url ? { link: url } : {}),
      terms: { version: TRAINER_TERMS_VERSION }, adult: true,
    });
    ceremony.current = null;
    setBusy(false);
    if (r.status === 200) { setAbout(""); setLink(""); setApplyResult({ kind: "sent" }); return; }
    if (r.status === 409 && r.body.needsNativePasskey) { setLegacy(true); return; }
    if (r.status === 409 && r.body.status === "applied") { setApplyResult({ kind: "applied" }); return; }
    if (r.status === 409 && r.body.status === "denied") { setApplyResult({ kind: "denied", nextAt: toMs(r.body.nextAt) }); return; }
    // Already a trainer (approved or set up since sign-in): sign in for the roster.
    if ((r.status === 403 && r.body.trainer) || (r.status === 409 && r.body.status === "approved")) { reset(); setPhase("signedOut"); setError(APPLY_COPY.alreadyTrainer); return; }
    if (r.status === 401) { reset(); setPhase("signedOut"); setError(APPLY_COPY.signInAgain); return; }
    const closed = r.status === 503 ? applyClosed(r) : null;
    if (closed === "paused") { setError(APPLY_COPY.paused); return; }
    if (closed === "notOpen") { setNotOpen(true); return; }
    setError(r.status === 400 ? APPLY_COPY.checkFields : replyError(r));
  };

  // "Set me up as a trainer" / "Agree with Face ID". Tapping is the
  // acceptance: 18+ and the current Trainer Terms ride in the body.
  const agree = async () => {
    if (busy) return;
    const fresh = ceremony.current && Date.now() - ceremony.current.at < CEREMONY_REUSE_MS ? ceremony.current : null;
    const name = fresh?.name || typedName();
    if (!name) { setError("Type your Heatwayve name first."); nameRef.current?.focus(); return; }
    setWho(name); setBusy(true); setError(null); setNotOpen(false); setLegacy(false);
    const c = fresh || await runCeremony(name);
    if (!c) { setBusy(false); return; }
    const r = await call("/api/trainer/upgrade", {
      authToken: c.token, profile: c.name, terms: { version: TRAINER_TERMS_VERSION }, adult: true,
    });
    ceremony.current = null;
    setBusy(false);
    if (r.status === 200) { await loadRoster(); return; }
    // Setting up directly is the admin's (and a trainer re-agreeing); anyone else applies.
    if (r.status === 403 && r.body.apply) { setPhase("apply"); return; }
    if (r.status === 409 && r.body.needsNativePasskey) { setLegacy(true); return; }
    if (r.status === 503) { setNotOpen(true); return; }
    setError(replyError(r));
  };

  const [signOutOpen, setSignOutOpen] = useState(false);
  const signOut = async (everywhere) => {
    if (busy) return;
    setBusy(true);
    await call("/api/trainer/session/end", everywhere ? { everywhere: true } : {});
    setBusy(false);
    reset(); setError(null); setPhase("signedOut");
    if (window.history.state?.view === "client") window.history.replaceState({}, "");
  };

  // ── The client pane ───────────────────────────────────────────────────────

  const clearPane = () => { setOpen(null); setPane(null); };

  const showClient = async (i, c) => {
    const seq = ++paneSeq.current;
    setOpen({ i, ref: c.ref, name: c.name, lastLooked: c.lastLooked });
    setPane({ ref: c.ref, state: "loading" });
    // The pane's top into view once it renders (under 640 it replaces the roster).
    window.requestAnimationFrame?.(() => mainRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
    const r = await call("/api/trainer/client", { ref: c.ref, today: todayLocalIso() });
    if (seq !== paneSeq.current) return;
    if (r.status === 200 && r.body.view) setPane({ ref: c.ref, state: "ready", client: r.body.client, view: r.body.view, self: r.body.self === true });
    else if (r.status === 404) setPane({ ref: c.ref, state: "missing" });
    else if (r.status === 401) { reset(); setPhase("signedOut"); }
    else if (r.status === 403 && r.body.needsTerms) toTerms();
    else setPane({ ref: c.ref, state: "error" });
  };

  const openRow = (i, c) => {
    if (!c || open?.ref === c.ref) return;
    // One entry for "a client is open": switching clients replaces it, so
    // Back always returns to no selection.
    const state = c === SELF_ROW ? { view: "client", self: true } : { view: "client", i };
    if (window.history.state?.view === "client") window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    entryRef.current = c.ref;
    showClient(i, c);
  };
  const openClient = (i) => openRow(i, clients[i]);
  const openSelf = () => openRow(-1, SELF_ROW);

  const closeClient = () => {
    if (window.history.state?.view === "client") window.history.back();
    else clearPane();
  };

  const onPop = useEffectEvent((e) => {
    const st = e.state;
    const c = st?.view !== "client" ? null : st.self === true ? SELF_ROW : clients[st.i];
    if (c && c.ref === entryRef.current) {
      if (open?.ref !== c.ref) showClient(st.i, c);
    } else {
      clearPane();
    }
  });
  useEffect(() => {
    const h = (e) => onPop(e);
    window.addEventListener("popstate", h);
    return () => window.removeEventListener("popstate", h);
  }, []);

  // `ref` is the pane's own client, the one its confirm sheet names. False
  // keeps the sheet open with a line saying it didn't go through; a 404
  // means it had already ended.
  const removeClient = async (ref) => {
    const r = await call("/api/trainer/clients", { remove: ref });
    if (r.status === 401) { reset(); setPhase("signedOut"); return true; }
    if (r.status !== 200 && r.status !== 404) return false;
    if (open?.ref === ref) closeClient();
    await loadRoster();
    return true;
  };

  // ── Changes to a client's plan ────────────────────────────────────────────

  // The pane's change route: its grant and today's date ride every call.
  const changePlan = async (ref, body) => {
    const r = await call("/api/trainer/change", { ...body, ref, today: todayLocalIso() });
    if (r.status === 401) { reset(); setPhase("signedOut"); }
    else if (r.status === 403 && r.body.needsTerms) toTerms();
    return r;
  };

  // A fresh Face ID for a change: the quiet sign-in again, for the name
  // signed in, which mints a new session. False when cancelled or failed.
  const confirmFaceId = async () => {
    const name = (who || me || "").trim();
    if (!name) return false;
    let auth;
    try {
      auth = await authenticatePasskey(name, { quiet: true });
    } catch {
      return false;
    }
    if (!auth?.authToken) return false;
    const r = await call("/api/trainer/session", { authToken: auth.authToken, profile: name });
    if (r.status === 200) {
      if (typeof r.body.name === "string") setMe(r.body.name);
      return true;
    }
    if (r.status === 401) { reset(); setPhase("signedOut"); }
    else if (r.status === 403 && r.body.needsTerms) toTerms();
    return false;
  };

  // After a send or a withdraw the open pane reloads in place: no "One
  // moment", so its place on the page and its last line stay. A reply that
  // lands after another client opened, or behind a later reload, is dropped
  // (null). True when the pane reloaded, false when it didn't.
  const refreshPane = async (ref) => {
    const seq = paneSeq.current;
    const mine = ++refreshSeq.current;
    const r = await call("/api/trainer/client", { ref, today: todayLocalIso() });
    if (seq !== paneSeq.current || mine !== refreshSeq.current) return null;
    if (r.status === 200 && r.body.view) { setPane({ ref, state: "ready", client: r.body.client, view: r.body.view, self: r.body.self === true }); return true; }
    if (r.status === 404) setPane({ ref, state: "missing" });
    else if (r.status === 401) { reset(); setPhase("signedOut"); }
    else if (r.status === 403 && r.body.needsTerms) toTerms();
    return false;
  };

  // ── The invite ────────────────────────────────────────────────────────────

  const issue = async () => {
    const seq = ++inviteSeq.current;
    setInvite({ issuing: true });
    const r = await call("/api/trainer/invite", { action: "issue" });
    if (seq !== inviteSeq.current) return;
    if (r.status === 200 && r.body.code) {
      setInvite({ code: r.body.code, expiresAt: r.body.expiresAt, issuedAt: Date.now() });
    } else if (r.status === 401) {
      reset(); setPhase("signedOut");
    } else {
      setInvite({ error: r.status === 503 ? APPLY_COPY.notOpen : replyError(r) });
    }
  };
  const closeInvite = () => { inviteSeq.current += 1; setInvite(null); };

  // Back, not a push, as on the other pages under Profile: a pushed /profile
  // would leave this page behind it. An open client's own entry sits on top,
  // so step past that too.
  const toProfile = () => withNavTransition(() => {
    const steps = window.history.state?.view === "client" ? 2 : 1;
    if (window.history.length <= steps) router.replace("/profile");
    else if (steps === 2) window.history.go(-2);
    else router.back();
  }, "nav-back");
  const profileRow = (style) => (
    <button type="button" onClick={toProfile} style={style}>
      <Glyph name="arrowLeft" size={12} color={T.ink3}/> Profile
    </button>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const root = {
    className: "forge-wide",
    style: { paddingTop: 72, paddingBottom: 48, fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased" },
  };

  if (phase !== "roster") {
    return (
      <div {...root}>
        <div className="forge-wide-solo">
          {profileRow(backRow)}
          {phase === "loading" && <div role="status" style={{ fontSize: 13, color: T.ink3 }}>One moment</div>}
          {phase === "error" && (
            <>
              <div style={kickerStyle}>For trainers</div>
              <h1 style={h1Style}>Your clients</h1>
              <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6 }}>Couldn't load your clients just now.</p>
              <button type="button" onClick={() => { setPhase("loading"); loadRoster(); }} style={{ ...quietBtn, width: "100%", marginTop: 12 }}>Try again</button>
            </>
          )}
          {phase === "signedOut" && (
            <>
              <div style={kickerStyle}>For trainers</div>
              <h1 style={h1Style}>Your clients</h1>
              <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 32px" }}>Sign in to see training your clients share with you.</p>
              <NameField inputRef={nameRef} disabled={busy}/>
              <button type="button" onClick={signIn} aria-disabled={busy} className="forge-press forge-lift" {...pressLiftHandlers}
                style={{ ...commitBtn, opacity: busy ? 0.6 : 1 }}>
                {busy ? "One moment" : "Sign in with Face ID"}
              </button>
            </>
          )}
          {phase === "apply" && (
            <ApplyPanel who={me || who} askName={!who} nameRef={nameRef} busy={busy} result={applyResult}
              about={about} link={link} onAbout={setAbout} onLink={setLink} onSend={sendApplication}/>
          )}
          {(phase === "upgrade" || phase === "terms") && (
            <UpgradePanel terms={phase === "terms"} who={me || who} askName={phase === "terms" && !who}
              nameRef={nameRef} busy={busy} onAgree={agree}/>
          )}
          {legacy && (
            <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "16px 0 0" }}>
              This needs a passkey for heatwayve.app. Update it in the Heatwayve app on your phone, then sign in here.
            </p>
          )}
          <div role="status" aria-live="polite" style={{ fontSize: 12, color: T.ink2, marginTop: 10, minHeight: 16 }}>
            {notOpen ? APPLY_COPY.notOpen : error || ""}
          </div>
        </div>
      </div>
    );
  }

  const selected = open ? clients.findIndex((c) => c.ref === open.ref) : -1;
  const selfOpen = open?.ref === SELF_REF;
  const shown = open && pane?.ref === open.ref ? pane : null;
  return (
    <div {...root} data-view={open ? "client" : "roster"}>
      {/* Above both columns; under 640 the open client's own row stands in. The shell's gap spaces it. */}
      <div className="forge-wide-back">{profileRow({ ...backRow, marginBottom: 0 })}</div>
      <div className="forge-wide-roster">
        <div style={kickerStyle}>For trainers</div>
        <h1 style={h1Style}>Your clients</h1>
        <button type="button" onClick={issue} className="forge-press forge-tint"
          style={{ ...quietBtn, width: "100%", marginTop: 14, marginBottom: 20 }}>
          Add a client
        </button>
        {/* Your own training, pinned first; a hairline sets it apart from clients. */}
        <div data-self-row="" style={{ borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}` }}>
          <button type="button" onClick={openSelf} aria-current={selfOpen ? "true" : undefined}
            className="forge-press forge-tint" style={rowStyle(selfOpen)}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={rowTitle}>Your training</span>
              <span style={rowLine}>As you&apos;d share it, read only</span>
            </span>
            <span className="forge-wide-n-only" style={{ flexShrink: 0, lineHeight: 0 }}>
              <Glyph name="arrowRight" size={12} color={T.ink3}/>
            </span>
          </button>
        </div>
        {clients.length === 0 ? (
          <p className="forge-wide-n-only" style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "14px 0 0" }}>{EMPTY_ROSTER}</p>
        ) : (
          <ul aria-label="Clients" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {clients.map((c, i) => {
              const line = signalText(c.signal, c.since);
              const current = i === selected;
              return (
                <li key={c.ref} style={{ borderBottom: `1px solid ${T.ruleFaint}` }}>
                  <button type="button" onClick={() => openClient(i)} aria-current={current ? "true" : undefined}
                    className="forge-press forge-tint" style={rowStyle(current)}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={rowTitle}>{c.name || "Your client"}</span>
                      <span className="forge-wide-signal" title={line} style={rowLine}>
                        <Nums text={line}/>
                      </span>
                    </span>
                    <span className="forge-wide-n-only" style={{ flexShrink: 0, lineHeight: 0 }}>
                      <Glyph name="arrowRight" size={12} color={T.ink3}/>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ marginTop: 28, fontSize: 12, color: T.ink3 }}>
          {me && <div style={{ marginBottom: 4 }}>Signed in as {me}</div>}
          <button type="button" onClick={() => setSignOutOpen(true)} style={linkBtn}>Sign out</button>
        </div>
        {signOutOpen && <SignOutSheet onPick={(everywhere) => { setSignOutOpen(false); signOut(everywhere); }} onClose={() => setSignOutOpen(false)}/>}
      </div>

      <div className="forge-wide-main" ref={mainRef} style={{ minWidth: 0 }}>
        {open && (
          // The tier class sits on the wrapper: the button's inline display would beat it.
          <div className="forge-wide-n-only">
            <button type="button" onClick={closeClient} style={backRow}>
              <Glyph name="arrowLeft" size={12} color={T.ink3}/> Clients
            </button>
          </div>
        )}
        {!open && (
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "8px 0 0" }}>
            {clients.length === 0 ? EMPTY_ROSTER : "Pick a client to see their training."}
          </p>
        )}
        {shown?.state === "loading" && <div role="status" style={{ fontSize: 13, color: T.ink3 }}>One moment</div>}
        {(shown?.state === "missing" || shown?.state === "error") && (
          <div>
            <p style={{ fontSize: 15, color: T.ink, margin: "0 0 14px" }}>
              {shown.state === "missing" ? "Not shared with you now." : "Couldn't open that just now."}
            </p>
            <button type="button" onClick={() => { closeClient(); loadRoster(); }} style={quietBtn}>Back to clients</button>
          </div>
        )}
        {shown?.state === "ready" && (
          <TrainerClientView key={shown.ref} client={shown.client} view={shown.view} self={shown.self}
            lastLooked={open.lastLooked} now={loadedAt} onRemove={shown.self ? undefined : () => removeClient(shown.ref)}
            onChange={shown.self ? undefined : (body) => changePlan(shown.ref, body)}
            onFaceId={shown.self ? undefined : confirmFaceId}
            onChanged={shown.self ? undefined : () => refreshPane(shown.ref)}
            clientRef={shown.self ? null : shown.ref} onExport={exportCsv}/>
        )}
      </div>

      {invite && (
        <InviteSheet invite={invite} onIssue={issue} onClose={closeInvite} onUsed={loadRoster}/>
      )}
    </div>
  );
}

const EMPTY_ROSTER = "No clients yet. Show them a code; they add you under Profile.";

function NameField({ inputRef, disabled }) {
  return (
    <>
      <label htmlFor="hw-trainer-name" style={{ display: "block", fontSize: 13, color: T.ink3, marginBottom: 6 }}>Your Heatwayve name</label>
      <input id="hw-trainer-name" ref={inputRef} defaultValue="" autoComplete="username" autoCapitalize="none"
        autoCorrect="off" spellCheck={false} disabled={disabled}
        style={{ width: "100%", boxSizing: "border-box", height: 48, padding: "0 14px", fontFamily: T.text, fontSize: 16, color: T.ink, background: "transparent", border: `1px solid ${T.rule}`, borderRadius: T.r, marginBottom: 20 }}/>
    </>
  );
}

/** @type {import("react").CSSProperties} */
const fieldLabel = { display: "block", fontSize: 13, color: T.ink3, marginBottom: 6 };
/** @type {import("react").CSSProperties} */
const fieldStyle = {
  width: "100%", boxSizing: "border-box", padding: "12px 14px", fontFamily: T.text, fontSize: 16, color: T.ink,
  background: "transparent", border: `1px solid ${T.rule}`, borderRadius: T.r,
};

// What being a trainer means, and the name clients see.
function Pitch({ who }) {
  return (
    <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 20px" }}>
      {"See your clients' training, never their photos, bodyweight, sleep or why they're on a breather, and change their plan when they allow it. "
        + (who ? `They approve you with Face ID, can stop any time, and see you as ${who}.` : "They approve you with Face ID and can stop any time.")}
    </p>
  );
}

// The Trainer Terms summary, the commit, and the 18+ and Terms line under
// it: the commit is the acceptance.
function TermsCommit({ label, busy, onCommit }) {
  const line = TRAINER_TERMS_COPY.line;
  const cut = line.indexOf("Trainer Terms");
  return (
    <>
      <ul style={{ listStyle: "none", margin: "0 0 24px", padding: 0, borderTop: `1px solid ${T.rule}` }}>
        {TRAINER_TERMS_COPY.summary.map((s) => (
          <li key={s} style={{ padding: "12px 2px", borderBottom: `1px solid ${T.rule}`, fontSize: 14, color: T.ink, lineHeight: 1.5 }}>{s}</li>
        ))}
      </ul>
      <button type="button" onClick={onCommit} aria-disabled={busy} aria-describedby="hw-trainer-terms"
        className="forge-press forge-lift" {...pressLiftHandlers} style={{ ...commitBtn, opacity: busy ? 0.6 : 1 }}>
        {busy ? "One moment" : label}
      </button>
      <p id="hw-trainer-terms" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "10px 0 0" }}>
        {cut >= 0 ? (
          <>
            {line.slice(0, cut)}
            <a href={TRAINER_TERMS_COPY.href} target="_blank" rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>Trainer Terms</a>
            {line.slice(cut + "Trainer Terms".length)}
          </>
        ) : line}
      </p>
    </>
  );
}

// Not a trainer yet: the application, or where it stands once sent.
function ApplyPanel({ who, askName, nameRef, busy, result, about, link, onAbout, onLink, onSend }) {
  const counting = about.length >= ABOUT_COUNT_FROM;
  return (
    <>
      <div style={kickerStyle}>For trainers</div>
      <h1 style={h1Style}>Coach on Heatwayve</h1>
      {result ? (
        // Replaces the form and its Send button: announced, and focus lands here.
        <div data-apply-result={result.kind} role="status" tabIndex={-1} ref={focusOnMount} style={{ outline: "none" }}>
          <p style={{ fontSize: 15, color: T.ink, lineHeight: 1.5, margin: "0 0 8px" }}>
            {result.kind === "sent" ? APPLY_COPY.sent : result.kind === "applied" ? APPLY_COPY.applied : deniedLine(result.nextAt)}
          </p>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: 0 }}>{APPLY_COPY.carryOn}</p>
        </div>
      ) : (
        <>
          <Pitch who={who}/>
          <p style={{ fontSize: 14, color: T.ink, lineHeight: 1.6, margin: "0 0 20px" }}>{APPLY_COPY.lead}</p>
          {askName && <NameField inputRef={nameRef} disabled={busy}/>}
          <label htmlFor="hw-apply-about" style={fieldLabel}>{APPLY_COPY.aboutLabel}</label>
          <textarea id="hw-apply-about" value={about} onChange={(e) => onAbout(e.target.value)} maxLength={ABOUT_MAX}
            rows={4} placeholder={APPLY_COPY.aboutHint} disabled={busy} aria-describedby={counting ? "hw-apply-count" : undefined}
            style={{ ...fieldStyle, display: "block", resize: "vertical", lineHeight: 1.45 }}/>
          {/* The count shows near the limit only; the line keeps its height so nothing jumps. */}
          <div id="hw-apply-count" style={{ fontSize: 12, color: T.ink3, textAlign: "right", minHeight: 16, margin: "4px 0 12px" }}>
            {counting ? <Nums text={`${ABOUT_MAX - about.length} left`}/> : null}
          </div>
          <label htmlFor="hw-apply-link" style={fieldLabel}>{APPLY_COPY.linkLabel}</label>
          <input id="hw-apply-link" type="url" inputMode="url" value={link} onChange={(e) => onLink(e.target.value)}
            maxLength={LINK_MAX} placeholder={APPLY_COPY.linkHint} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            disabled={busy} style={{ ...fieldStyle, height: 48, padding: "0 14px", marginBottom: 24 }}/>
          <TermsCommit label={APPLY_COPY.send} busy={busy} onCommit={onSend}/>
        </>
      )}
    </>
  );
}

// The admin setting up directly, or a trainer whose Trainer Terms changed.
function UpgradePanel({ terms, who, askName, nameRef, busy, onAgree }) {
  return (
    <>
      <div style={kickerStyle}>For trainers</div>
      <h1 style={h1Style}>{terms ? "The Trainer Terms changed" : "Coach on Heatwayve"}</h1>
      <Pitch who={who}/>
      {askName && <NameField inputRef={nameRef} disabled={busy}/>}
      <TermsCommit label={terms ? "Agree with Face ID" : "Set me up as a trainer"} busy={busy} onCommit={onAgree}/>
    </>
  );
}

// "Add a client": the code, how the client uses it, and whether they have.
// It polls while open and visible, and stops after 20 minutes. Sheets carry
// no press visuals.
/** Sign out of this device, or of every device the trainer session is on. */
function SignOutSheet({ onPick, onClose }) {
  const { containerRef, onKeyDown } = useInlineModalA11y(true, onClose);
  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="trainer-signout-title" tabIndex={-1}
        onClick={(e) => e.stopPropagation()} className="forge-sheet-ground forge-vellum"
        style={{ padding: "26px 24px calc(24px + env(safe-area-inset-bottom))", width: "100%", animation: `slideUp 260ms ${T.ease}`, boxSizing: "border-box", outline: "none", fontFamily: T.text, color: T.ink }}>
        <div id="trainer-signout-title" style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.3, marginBottom: 6 }}>Sign out</div>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.55, margin: "0 0 18px" }}>Everywhere ends this trainer sign-in on every device. Your training app stays signed in.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={() => onPick(false)} style={quietBtn}>This device</button>
          <button type="button" onClick={() => onPick(true)} style={quietBtn}>Everywhere</button>
        </div>
        <button type="button" onClick={onClose} style={{ ...linkBtn, marginTop: 18, display: "block", margin: "18px auto 0" }}>Cancel</button>
      </div>
    </div>
  );
}

function InviteSheet({ invite, onIssue, onClose, onUsed }) {
  const { containerRef, onKeyDown } = useInlineModalA11y(true, onClose);
  const [status, setStatus] = useState(null); // { code, status, usedBy } for the code shown
  const [now, setNow] = useState(invite.issuedAt || 0);
  const [shared, setShared] = useState(null);
  const code = invite.code || null;
  const usedNow = useEffectEvent(() => { onUsed?.(); });
  // The code that reached a final status (used, run out, cancelled): its
  // poll stops and coming back to the tab does not start it again.
  const finalFor = useRef(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!code) return undefined;
    let off = false;
    let timer = null;
    const stopAt = invite.issuedAt + POLL_FOR_MS;
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    const tick = async () => {
      if (finalFor.current === code) { stop(); return; }
      const t = Date.now();
      setNow(t);
      if (t >= invite.expiresAt) { finalFor.current = code; stop(); return; }
      if (t > stopAt || document.visibilityState !== "visible") return;
      const r = await call("/api/trainer/invite");
      if (off || finalFor.current === code || r.status !== 200) return;
      const st = r.body.status;
      if (st === "used" || st === "expired") {
        finalFor.current = code;
        stop();
        setStatus({ code, status: st, usedBy: r.body.usedBy ?? null });
        if (st === "used") usedNow();
      }
    };
    const start = () => { if (!timer) timer = setInterval(tick, POLL_MS); };
    const onVisible = () => {
      if (finalFor.current === code) return;
      if (document.visibilityState === "visible") { tick(); start(); } else stop();
    };
    start();
    document.addEventListener("visibilitychange", onVisible);
    return () => { off = true; stop(); document.removeEventListener("visibilitychange", onVisible); };
  }, [code, invite.issuedAt, invite.expiresAt]);

  const mine = status?.code === code ? status : null;
  // A new code starts its own clock; the last tick may belong to the old one.
  const at = Math.max(now, invite.issuedAt || 0);
  const state = mine?.status === "used" ? "used"
    : mine?.status === "expired" || mine?.status === "cancelled" || (code && at >= invite.expiresAt) ? "expired"
    : "pending";
  const minsLeft = code ? Math.max(0, Math.ceil((invite.expiresAt - at) / 60_000)) : 0;

  const onShare = async () => {
    const url = shareUrl(code);
    try {
      if (typeof navigator.share === "function") { await navigator.share({ url }); return; }
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
    try { await navigator.clipboard.writeText(url); setShared("copied"); } catch { setShared("fail"); }
  };
  const onCancel = async () => {
    const r = await call("/api/trainer/invite", { action: "cancel" });
    if (r.status === 200) { finalFor.current = code; setStatus({ code, status: "cancelled", usedBy: null }); }
  };

  // A final status (used, run out, cancelled) is what to read: it leads, and
  // the dead code fades under it.
  const final = state !== "pending";
  const statusText = !code ? ""
    : mine?.status === "cancelled" ? "Cancelled. This code no longer works."
    : state === "used" ? `${mine.usedBy || "Your client"} is in.`
    : state === "expired" ? "This code has run out."
    : "Waiting for them…";

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="trainer-invite-title" tabIndex={-1}
        onClick={(e) => e.stopPropagation()} className="forge-sheet-ground forge-vellum"
        style={{ padding: "26px 24px calc(24px + env(safe-area-inset-bottom))", width: "100%", animation: `slideUp 260ms ${T.ease}`, boxSizing: "border-box", outline: "none", fontFamily: T.text, color: T.ink }}>
        <div id="trainer-invite-title" style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.3, marginBottom: 14 }}>Show them this</div>

        {invite.issuing && <div role="status" style={{ fontSize: 13, color: T.ink3, minHeight: 32 }}>One moment</div>}
        {invite.error && <div role="status" style={{ fontSize: 14, color: T.ink2, lineHeight: 1.5 }}>{invite.error}</div>}
        {code && (
          // One live region throughout, so a change is announced. It sits first
          // in the DOM; while the code is live, order moves it below the how-to.
          <div style={{ display: "flex", flexDirection: "column" }}>
            {/* The QR only while the code works. Its light plate lines up with
                the text's left edge, inside the sheet's padding. */}
            {state === "pending" && (
              <div data-qr="" style={{ margin: "0 0 14px", width: QR_PX }}>
                <QrCode text={shareUrl(code)} width={QR_PX} height={QR_PX}/>
              </div>
            )}
            <div role="status" aria-live="polite" data-final={final ? "" : undefined}
              style={final
                ? { fontSize: 15, fontWeight: 500, color: T.ink, lineHeight: 1.4, margin: "0 0 10px", minHeight: 20 }
                : { order: 3, fontSize: 14, color: T.ink, margin: "14px 0 18px", minHeight: 20 }}>
              {statusText}
            </div>
            <div data-code="" style={{ fontFamily: T.measured, fontSize: 22, letterSpacing: "0.06em", color: final ? T.ink3 : T.ink, margin: "0 0 14px", opacity: final ? 0.3 : 1 }}>
              {formatCode(code)}
            </div>
            {!final && (
              <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.55, margin: "0 0 4px" }}>
                In Heatwayve, they go to Profile → Add a trainer and type this code. Works once, until <span style={{ fontFamily: T.measured }}>{clockTime(invite.expiresAt)}</span>.
              </p>
            )}
            {state === "pending" && (
              <p style={{ fontSize: 12, color: T.ink3, margin: 0 }}><Nums text={`${minsLeft} min left`}/></p>
            )}
            <div style={{ order: 4, display: "flex", gap: 10, flexWrap: "wrap", marginTop: final ? 18 : 0 }}>
              {state === "pending" && (
                <>
                  <button type="button" onClick={onShare} style={quietBtn}>{shared === "copied" ? "Copied" : "Share link"}</button>
                  <button type="button" onClick={onCancel} style={quietBtn}>Cancel code</button>
                </>
              )}
              {state !== "pending" && (
                <button type="button" onClick={onIssue} style={quietBtn}>New code</button>
              )}
            </div>
            {shared === "fail" && <div style={{ order: 5, fontSize: 12, color: T.ink2, marginTop: 8 }}>Couldn't reach the clipboard. Read the code out instead.</div>}
          </div>
        )}
        <button type="button" onClick={onClose}
          style={{ width: "100%", padding: "12px", marginTop: 14, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.ink3, fontFamily: T.text }}>
          Done
        </button>
      </div>
    </div>
  );
}
