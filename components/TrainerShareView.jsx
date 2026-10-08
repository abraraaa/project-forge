"use client";

// components/TrainerShareView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// /profile/trainer: who sees your training, since when, what they see, and
// every time they looked. Stop sharing is one tap (it only reduces access).
// With no trainer, this is where a code is entered: ShareApprove, as the
// profile this app is already in. The name comes from P.getActive() and is
// never typed.
// Changes a trainer made to the plan are listed here with where each stands,
// and Undo. This page never writes the plan: an undo is recorded on the
// server, and the app puts the old value back through its own edits the next
// time it opens the plan (lib/trainer-change.js planDeviceSteps).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { T, DISPLAY } from "@/lib/tokens";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import ErrorBoundary from "@/components/ErrorBoundary";
import ShareApprove, { APPROVE_COPY } from "@/components/ShareApprove";
import { P } from "@/lib/storage";
import { withNavTransition } from "@/lib/nav-transitions";
import { ago } from "@/lib/coach-connect";
import { fetchWithTimeout } from "@/lib/net";
import { authenticatePasskey } from "@/lib/webauthn";
import { todayLocalIso } from "@/lib/dates";
import { timedTargetFor } from "@/lib/programme";
import { SHARE_CONSENT_VERSION, SHARE_COPY } from "@/lib/trainer-terms";

const LOG_SHOWN = 20;
const OFFLINE = "Couldn't reach Heatwayve. Try again.";
const NOT_STOPPED = "That didn't go through. Try again.";
const SIGN_IN = "Sign in again to see your trainer.";
const WENT_WRONG = "Couldn't do that just now. Try again.";
const FACE_ID = "Face ID didn't go through. Try again.";
const NATIVE = "This needs a passkey for heatwayve.app first.";
const NOT_UNDONE = "That can't be undone now. You've trained at it since, or it was already changed.";
const focusOnMount = (el) => { el?.focus(); };
const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } };

const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
// Roster looks carry a London calendar day ("2026-09-29"), read as that day.
const dayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const londonDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
const sentDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** "today", "yesterday" or "Mon 29 Sep", for a roster check-in's London day. */
function rosterDayLabel(day, now) {
  const today = londonDay.format(new Date(now));
  if (day === today) return "today";
  if (day === londonDay.format(new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000))) return "yesterday";
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? dayLabel.format(new Date(t)) : "";
}

/**
 * The share status. A refusal is worded here, never in the server's words.
 * @returns {Promise<{ ok: true, body: any } | { ok: false, error: string }>}
 */
async function fetchShare(profile) {
  try {
    // today: this device's date, which a change's status is read against.
    const res = await fetchWithTimeout(`/api/sync/trainer?profile=${encodeURIComponent(profile)}&today=${todayLocalIso()}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, body };
    return { ok: false, error: res.status === 429 ? APPROVE_COPY.slowDown : res.status === 401 ? SIGN_IN : WENT_WRONG };
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

// ─── A trainer's changes, in words ───────────────────────────────────────────

/** A calendar day ("2026-10-14") as "Tue 14 Oct". */
const dayOf = (iso) => {
  const t = typeof iso === "string" ? Date.parse(`${iso}T12:00:00Z`) : NaN;
  return Number.isFinite(t) ? dayLabel.format(new Date(t)) : "";
};
const kg = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null);
const lead = (v) => {
  const m = typeof v === "number" ? [String(v), String(v)] : typeof v === "string" ? v.match(/^\s*(\d+)/) : null;
  return m ? m[1] : null;
};
/** Reps as they read: "8 reps", "10 reps a leg", or seconds for a timed hold. */
function repsText(lift, v) {
  const n = lead(v);
  if (n === null) return null;
  if (timedTargetFor(lift)) return `${n} s`;
  return typeof v === "string" && /\/leg/.test(v) ? `${n} reps a leg` : `${n} reps`;
}

/** What changed: "Back Squat · 105 kg, was 102.5". */
export function changeText(c) {
  if (c.kind === "weight") {
    const was = kg(c.before);
    return `${c.target} · ${kg(c.after) ?? "?"} kg${was !== null ? `, was ${was}` : ""}`;
  }
  if (c.kind === "reps") {
    const was = lead(c.before);
    return `${c.target} · ${repsText(c.target, c.after) ?? "?"}${was !== null ? `, was ${was}` : ""}`;
  }
  if (c.kind === "mainLift") return `Main lift · ${c.after}, was ${c.before || c.target}`;
  return c.from ? `Your week from ${dayOf(c.from)}` : "Your week";
}

const NOT_APPLIED = {
  superseded: "You trained before it arrived",
  already_there: "You were already there",
  deload: "Arrived during your deload",
  limits: "Outside the app's limits when it arrived",
  replaced: "Replaced by a newer change",
};

/**
 * Where a change stands, in the client's words. A change that never arrived
 * ("stopped") says why from the change itself: one sent on the share that is
 * still here (by its trainer, at or after the share began) was cancelled by
 * changes going off, or by the share pausing; one from an earlier share, by
 * that sharing stopping. Never from the switch as it stands now, which may
 * have gone back on since. An inference until the route sends each row's own
 * reason: while paused, a change cancelled earlier by changes going off also
 * reads as paused, and with no public name (who null) every one reads as
 * sharing stopped.
 * @param {any} c  a change from GET /api/sync/trainer
 * @param {{ who: string | null, since?: number | null, live?: boolean }} share  the current share, if any
 */
export function changeStatusText(c, { who, since = null, live = false }) {
  switch (c.status) {
    case "waiting": return c.from ? `From ${dayOf(c.from)}` : "Next time you open the app";
    case "in_force": return "In your plan";
    case "trained_yours": {
      const when = c.date ? `, ${sentDate.format(new Date(Date.parse(`${c.date}T12:00:00Z`)))}` : "";
      return `You trained at it${when}${c.cooked ? ", on a cooked day" : ""}`;
    }
    case "changed_since": return "You changed it since";
    case "undone": return "Undone";
    case "withdrawn": return `Withdrawn by ${c.by || "your trainer"}`;
    case "not_applied":
      if (c.reason === "stopped") {
        const thisShare = !!who && c.by === who && Number.isFinite(since) && Number.isFinite(c.at) && c.at >= /** @type {number} */ (since);
        if (!thisShare) return "Sharing stopped";
        return live ? "Changes were off" : "Sharing paused";
      }
      return NOT_APPLIED[c.reason] || "Not in your plan";
    default: return "";
  }
}

const WARNINGS = {
  big_drop: "A big drop from your last top set.",
  double_progression: "Weight and reps both go up.",
  off_programme_reps: "Outside this lift's usual reps.",
  below_rep_band: "Fewer reps than the app usually sets.",
  band: "Changes which muscles your week works.",
  under_mev: "Some muscles would get less than the minimum.",
  over_mrv: "Some muscles would get more than they can recover from.",
};
const warningText = (codes) => (Array.isArray(codes) ? codes.map((w) => WARNINGS[w]).filter(Boolean) : []).join(" ");

/** Undo is one tap while a change waits or sits in the plan. A week in the plan goes back through the week editor. */
const canUndo = (c) => c.undoable === true && !(c.kind === "week" && c.status === "in_force");

/**
 * What an undo did, in one line. Waiting rows change nothing, so only the
 * rest are described. One row names the value it goes back to; a weight or
 * reps they never had goes back to none (the app writes an unset).
 * @param {any[]} rows
 */
function undoneLine(rows) {
  if (!rows.length) return "Undone.";
  const live = rows.filter((c) => c.status !== "waiting");
  if (!live.length) return "Undone. It won't change your plan.";
  if (live.length > 1) return "Undone. Your plan goes back next time you open the app.";
  const [c] = live;
  const back = c.kind === "weight" ? (kg(c.before) !== null ? `${kg(c.before)} kg` : null)
    : c.kind === "reps" ? repsText(c.target, c.before)
    : c.kind === "mainLift" ? (c.before || c.target) : null;
  return back ? `Undone. Back to ${back} next time you open the app.` : "Undone. Your plan goes back next time you open the app.";
}

/** The changes, newest set first, grouped by the set they were sent in. */
function bySet(changes) {
  const sets = [];
  const at = new Map();
  for (const c of changes) {
    if (!at.has(c.set)) { at.set(c.set, sets.length); sets.push({ id: c.set, at: c.at, by: c.by, rows: [] }); }
    sets[at.get(c.set)].rows.push(c);
  }
  return sets;
}

export default function TrainerShareView() {
  const router = useRouter();
  const [current] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [now] = useState(() => Date.now());
  const [state, setState] = useState(/** @type {{ ok: true, body: any } | { ok: false, error: string } | null} */ (null));
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState(/** @type {string | null} */ (null));
  const [stopped, setStopped] = useState(/** @type {string | null} */ (null));
  // A fresh code approved while paused: the reload names the new share, and
  // its heading takes focus.
  const [arrived, setArrived] = useState(false);
  // "Not now" on a fresh code while paused: a new approval, back on the paused share.
  const [approveKey, setApproveKey] = useState(0);
  const headRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  // The ended notice the client dismissed this visit.
  const [seen, setSeen] = useState(/** @type {string | null} */ (null));
  // The changes switch and undo: what is in flight, and the line that says how it went.
  const [editsBusy, setEditsBusy] = useState(false);
  const [editsLine, setEditsLine] = useState(/** @type {string | null} */ (null));
  const [undoing, setUndoing] = useState(/** @type {string | null} */ (null));
  const [undoLine, setUndoLine] = useState(/** @type {string | null} */ (null));
  const undoLineRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const markedSeen = useRef(false);
  const hasChanges = !!(state?.ok && Array.isArray(state.body?.changes) && state.body.changes.length > 0);

  // The list showed: the dot for new changes goes. Write: POST { seenChanges }
  // -> dbMarkSeen, the account's one 'trainerChange' mark, overwritten in
  // place. If it doesn't get through, the dot stays, nothing more.
  useEffect(() => {
    if (!current || !hasChanges || markedSeen.current) return;
    markedSeen.current = true;
    fetchWithTimeout("/api/sync/trainer", { ...JSON_POST, body: JSON.stringify({ profile: current, seenChanges: true }) }).catch(() => {});
  }, [current, hasChanges]);

  useEffect(() => {
    if (!current) return undefined;
    let off = false;
    fetchShare(current).then((r) => { if (!off) setState(r); });
    return () => { off = true; };
  }, [current]);

  useEffect(() => {
    if (!current) router.replace("/");
  }, [current, router]);
  if (!current) return null;

  const toProfile = () => withNavTransition(() => {
    if (window.history.length > 1) router.back();
    else router.replace("/profile");
  }, "nav-back");

  const body = state?.ok ? state.body : null;
  const sharing = body?.sharing || null;
  const ended = body?.ended || null;

  const onStop = async () => {
    if (stopping || !sharing) return;
    setStopping(true);
    setStopError(null);
    let res = null;
    try {
      res = await fetchWithTimeout("/api/sync/trainer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: current, stop: sharing.ref }),
      });
    } catch { /* said below */ }
    if (res?.ok) {
      setStopped(sharing.name);
      // Stopped is stopped, even if the reload below can't get through.
      setState((s) => (s?.ok ? { ok: true, body: { ...s.body, sharing: null } } : s));
    }
    // Either way, show what is true now.
    const next = await fetchShare(current);
    if (next.ok) setState(next);
    // Only a request that never arrived is blamed on the network.
    if (!res) setStopError(OFFLINE);
    else if (!res.ok && "error" in next) setStopError(next.error);
    else if (!res.ok && "body" in next && next.body?.sharing?.ref === sharing.ref) setStopError(NOT_STOPPED);
    setStopping(false);
  };

  const onPausedCancel = () => {
    setApproveKey((k) => k + 1);
    headRef.current?.focus();
  };

  // "Dismiss": the notice goes now. Write: POST { seen } -> dbSeenEndedNotice,
  // an UPDATE of notice_seen_at on the client's own ended grant. If it
  // doesn't get through, the notice shows again next time, nothing more.
  const onSeen = (ref) => {
    setSeen(ref);
    fetchWithTimeout("/api/sync/trainer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: current, seen: ref }),
    }).catch(() => {});
    // Focus moves on to the code field, the next thing here. Without one,
    // the "No trainer" line that replaces the notice takes it as it mounts.
    document.getElementById("hw-share-code")?.focus();
  };

  const onApproved = async () => {
    const next = await fetchShare(current);
    if (next.ok) { setArrived(true); setState(next); }
  };

  const edits = body?.edits && typeof body.edits === "object" ? body.edits : null;
  const changes = Array.isArray(body?.changes) ? body.changes : [];

  // Turn the trainer's changes off (one tap: it only reduces access) or on
  // (Face ID). Writes: POST { edits } -> dbEditsOff / dbEditsOn, an UPDATE of
  // the client's own trainer grant. Then the page shows what is true now.
  const onEdits = async (on) => {
    if (editsBusy || !sharing) return;
    const who = sharing.name;
    setEditsBusy(true);
    setEditsLine(null);
    let authToken = null;
    if (on) {
      try {
        authToken = (await authenticatePasskey(current, { quiet: true }))?.authToken || null;
      } catch (e) {
        setEditsLine(e?.message === "WebAuthn not supported" ? APPROVE_COPY.noPasskeys : FACE_ID);
        setEditsBusy(false);
        return;
      }
      // Cancelled: back to where they were, nothing said.
      if (!authToken) { setEditsBusy(false); return; }
    }
    let res = null;
    let out = null;
    try {
      res = await fetchWithTimeout("/api/sync/trainer", {
        ...JSON_POST, body: JSON.stringify(on ? { profile: current, edits: true, authToken } : { profile: current, edits: false }),
      });
      out = await res.json().catch(() => ({}));
    } catch { /* said below */ }
    if (res?.ok) {
      setState((s) => (s?.ok ? { ok: true, body: { ...s.body, edits: { on, since: on ? Date.now() : null } } } : s));
      setEditsLine(on ? `${who} can change your plan now. Every change shows here.` : `${who} can't change your plan now. Anything not in it yet won't arrive.`);
    } else if (!res) setEditsLine(OFFLINE);
    else if (out?.fresh) setEditsLine(`Ask ${who} for a fresh code to let them change your plan.`);
    else if (out?.needsNativePasskey) setEditsLine(NATIVE);
    else if (res.status === 401) setEditsLine(on ? FACE_ID : SIGN_IN);
    else setEditsLine(NOT_STOPPED);
    const next = await fetchShare(current);
    if (next.ok) setState(next);
    setEditsBusy(false);
  };

  // Undo one change, or every undoable change in a set. Write: POST { undo }
  // -> dbUndoChanges, an UPDATE of undone_at on the client's own changes.
  // One that already landed is put back by the app on its next pull, through
  // the same stamped edits as any change they make.
  const onUndo = async (x, rows) => {
    if (undoing) return;
    setUndoing(x);
    setUndoLine(null);
    let res = null;
    let out = null;
    try {
      res = await fetchWithTimeout("/api/sync/trainer", { ...JSON_POST, body: JSON.stringify({ profile: current, undo: x }) });
      out = await res.json().catch(() => ({}));
    } catch { /* said below */ }
    if (res?.ok) {
      const done = new Set(Array.isArray(out?.undone) ? out.undone : []);
      setUndoLine(undoneLine(rows.filter((c) => done.has(c.id))));
      // Undone is undone, even if the reload below can't get through.
      setState((s) => (s?.ok && Array.isArray(s.body?.changes)
        ? { ok: true, body: { ...s.body, changes: s.body.changes.map((c) => (done.has(c.id) ? { ...c, status: "undone", undoable: false } : c)) } }
        : s));
    } else setUndoLine(!res ? OFFLINE : res.status === 409 ? NOT_UNDONE : res.status === 401 ? SIGN_IN : NOT_STOPPED);
    const next = await fetchShare(current);
    if (next.ok) setState(next);
    setUndoing(null);
    // The button is gone: the line that says what happened takes focus.
    undoLineRef.current?.focus();
  };

  const changesList = (who) => {
    if (!changes.length) return null;
    const allTheirs = !!who && changes.every((c) => c.by === who);
    const share = { who, since: who ? sharing?.since ?? null : null, live: !!who && sharing?.live === true };
    const small = { fontSize: 12, color: T.ink2, lineHeight: 1.5 };
    const undoBtn = { minHeight: 44, flexShrink: 0, background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontFamily: T.text, fontSize: 13, fontWeight: 500, color: T.ink };
    return (
      <Fade d={60}>
        <h2 style={{ marginTop: 28, marginBottom: 6, fontSize: 13, fontWeight: 400, color: T.ink3 }}>{allTheirs ? `Changes from ${who}` : "Changes to your plan"}</h2>
        <p style={{ ...small, margin: "0 0 10px" }}>Undo any change until you&apos;ve trained at it. Your logged sessions never change.</p>
        <div ref={undoLineRef} tabIndex={-1} role="status" aria-live="polite" style={{ ...small, color: T.ink, minHeight: 16, marginBottom: 6, outline: "none" }}>{undoLine || ""}</div>
        {bySet(changes).map((set) => {
          const open = set.rows.filter(canUndo);
          const sent = Number.isFinite(set.at) ? `Sent ${sentDate.format(new Date(set.at))}` : "Sent";
          return (
            <section key={set.id} aria-label={sent} style={{ borderTop: `1px solid ${T.rule}`, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12, color: T.ink3 }}>{sent}{set.by && set.by !== who ? ` by ${set.by}` : ""}</span>
                {open.length > 1 && (
                  <button type="button" onClick={() => onUndo(set.id, open)} aria-disabled={!!undoing} className="forge-press"
                    style={{ ...undoBtn, fontWeight: 400, color: T.ink2, opacity: undoing ? 0.6 : 1 }}>
                    {undoing === set.id ? "One moment" : "Undo all"}
                  </button>
                )}
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {set.rows.map((c) => {
                  const what = changeText(c);
                  const warn = warningText(c.warnings);
                  return (
                    <li key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 2px", borderBottom: `1px solid ${T.rule}` }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: T.ink, overflowWrap: "anywhere" }}>{what}</div>
                        <div style={{ ...small, marginTop: 2 }}>{changeStatusText(c, share)}</div>
                        {warn && <div style={{ ...small, color: T.under, marginTop: 2 }}>{warn}</div>}
                      </div>
                      {canUndo(c) && (
                        <button type="button" onClick={() => onUndo(c.id, [c])} aria-disabled={!!undoing} aria-label={`Undo ${what}`} className="forge-press"
                          style={{ ...undoBtn, opacity: undoing ? 0.6 : 1 }}>
                          {undoing === c.id ? "One moment" : "Undo"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </Fade>
    );
  };

  const kicker = <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>Your trainer</div>;
  const h1 = (text, ref) => (
    <h1 ref={ref} tabIndex={-1} style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 14px", overflowWrap: "anywhere", outline: "none" }}>{text}</h1>
  );
  const line = { fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "0 0 12px" };

  let content = null;
  if (sharing) {
    const who = sharing.name;
    const looks = Array.isArray(sharing.looks) ? sharing.looks.slice(0, LOG_SHOWN) : [];
    const count = Number(sharing.lookCount) || 0;
    content = (
      <>
        <Fade d={0}>
          {kicker}
          {h1(who, arrived ? focusOnMount : headRef)}
          {sharing.live ? (
            <>
              {/* What this share is now, in the approval's own rows: the
                  sessions, trend and client list always; with changes on,
                  also the plan, the top sets and what they can change; with
                  them off, that they can't. */}
              <ul aria-label={`What ${who} sees`} style={{ listStyle: "none", margin: "0 0 12px", padding: 0, borderTop: `1px solid ${T.rule}` }}>
                {(edits?.on
                  ? [0, 1, 2, 7, 8, 9].map((i) => SHARE_COPY.rows[i])
                  : [SHARE_COPY.rows[0], SHARE_COPY.rows[1], SHARE_COPY.rows[2], ...(edits ? ["Can't change your plan."] : [])]
                ).map((row) => (
                  <li key={row} style={{ padding: "12px 2px", borderBottom: `1px solid ${T.rule}`, fontSize: 14, color: T.ink, lineHeight: 1.5 }}>{row}</li>
                ))}
              </ul>
              <p style={{ ...line, marginBottom: 28 }}>Sharing since {longDate.format(new Date(sharing.since))}.</p>
            </>
          ) : (
            <p style={{ ...line, marginBottom: 28 }}>Paused. {who} can&apos;t see your training right now. Stop sharing, or ask {who} for a fresh code.</p>
          )}
          {/* One tap, no confirm: stopping only takes access away. */}
          {/* aria-disabled, not disabled: the button keeps focus while it works. */}
          <button type="button" onClick={onStop} aria-disabled={stopping} className="forge-press forge-tint"
            style={{ width: "100%", height: 52, background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink, opacity: stopping ? 0.6 : 1 }}>
            {stopping ? "One moment" : "Stop sharing"}
          </button>
          <div role="status" aria-live="polite" style={{ fontSize: 12, color: T.ink2, marginTop: 10, minHeight: 16 }}>{stopError || ""}</div>
          {/* Their changes: off in one tap, on again with Face ID. A share
              approved before changes were part of it needs a fresh code. */}
          {sharing.live && edits && (
            <div style={{ marginTop: 4 }}>
              {edits.on || sharing.consentVersion === SHARE_CONSENT_VERSION ? (
                <button type="button" onClick={() => onEdits(!edits.on)} aria-disabled={editsBusy} className="forge-press"
                  style={{ minHeight: 44, background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2, opacity: editsBusy ? 0.6 : 1 }}>
                  {editsBusy ? "One moment" : edits.on ? `Stop ${who} changing your plan` : `Let ${who} change your plan`}
                </button>
              ) : (
                <p style={{ fontSize: 12, color: T.ink2, lineHeight: 1.5, margin: 0 }}>Ask {who} for a fresh code to let them change your plan.</p>
              )}
              <div role="status" aria-live="polite" style={{ fontSize: 12, color: T.ink2, marginTop: 2, minHeight: 16 }}>{editsLine || ""}</div>
            </div>
          )}
          {/* Paused: a fresh code from them (or someone new) goes in here. */}
          {!sharing.live && body.open && (
            <div style={{ marginTop: 20 }}>
              <ShareApprove key={approveKey} name={current} level={2} onApproved={onApproved} onDone={toProfile} onCancel={onPausedCancel}
                lead={<p style={{ ...line, color: T.ink }}>Got a fresh code from {who}?</p>} />
            </div>
          )}
        </Fade>

        {changesList(who)}

        <Fade d={80}>
          <div style={{ marginTop: 28, marginBottom: 6, fontSize: 13, color: T.ink3 }}>When {who} looked</div>
          <p style={{ fontSize: 12, color: T.ink3, lineHeight: 1.6, margin: "0 0 10px" }}>Roster check-ins show once a day.</p>
          {looks.length ? (
            <ul aria-label={`When ${who} looked`} style={{ listStyle: "none", margin: 0, padding: 0, borderTop: `1px solid ${T.rule}` }}>
              {looks.map((l, i) => (
                <li key={`${l.at}-${i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "12px 2px", borderBottom: `1px solid ${T.rule}` }}>
                  <span style={{ fontSize: 14, color: T.ink, minWidth: 0, overflowWrap: "anywhere" }}>
                    {l.kind === "roster" ? `${who} checked in on the roster` : `${who} looked at your training`}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 12, color: T.ink3 }}>
                    {l.kind === "roster" ? rosterDayLabel(l.day || londonDay.format(new Date(l.at)), now) : ago(l.at, now)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 14, color: T.ink2, margin: "4px 0 0" }}>Not looked yet.</p>
          )}
          {count > 0 && (
            <p style={{ fontSize: 12, color: T.ink2, lineHeight: 1.5, margin: "10px 0 0" }}>
              {count > LOG_SHOWN
                ? `${count} looks in all. The latest ${LOG_SHOWN} show here.`
                : `${count} ${count === 1 ? "look" : "looks"} so far.`}
            </p>
          )}
        </Fade>
      </>
    );
  } else if (state?.ok) {
    // Under the heading, above the code field. Just stopped: it takes focus.
    const notice = stopped ? (
      <p role="status" tabIndex={-1} ref={focusOnMount} style={{ ...line, color: T.ink, marginBottom: 20, outline: "none" }}>
        Stopped. {stopped} can&apos;t see your training now.
      </p>
    ) : ended && !(ended.ref && seen === ended.ref) ? (
      <div style={{ marginBottom: 20 }}>
        <p style={{ ...line, margin: 0 }}>
          {ended.by === "closed"
            ? `${ended.name}'s account has closed. They no longer see your training.`
            : `${ended.name} stopped seeing your training on ${longDate.format(new Date(ended.at))}.`}
        </p>
        {ended.ref && (
          <button type="button" onClick={() => onSeen(ended.ref)} className="forge-press"
            style={{ minHeight: 44, background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2 }}>
            Dismiss
          </button>
        )}
      </div>
    ) : null;
    content = (
      <>
        <Fade d={0}>
          {kicker}
          {body.open ? (
            // ShareApprove carries the page heading: "Add a trainer", then whose code it is.
            <ShareApprove name={current} title="Add a trainer" lead={notice} onDone={toProfile} onCancel={toProfile} />
          ) : notice || (
            <p tabIndex={-1} ref={seen ? focusOnMount : undefined} style={{ ...line, outline: "none" }}>No trainer sees your training.</p>
          )}
        </Fade>
        {/* Sharing ended: changes already in the plan stay, each undoable. */}
        {changesList(null)}
      </>
    );
  } else if (state && "error" in state) {
    content = (
      <Fade d={0}>
        {kicker}
        <p role="status" style={line}>{state.error}</p>
      </Fade>
    );
  }

  return (
    <ErrorBoundary>
      <div style={{ background: "transparent", maxWidth: 430, margin: "0 auto", fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased", padding: "72px 24px 48px" }}>
        <button type="button" onClick={toProfile}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2, display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 32 }}>
          <Glyph name="arrowLeft" size={12} color={T.ink2}/> Profile
        </button>
        {content}
      </div>
    </ErrorBoundary>
  );
}
