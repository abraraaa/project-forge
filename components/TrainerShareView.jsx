"use client";

// components/TrainerShareView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// /profile/trainer: who sees your training, since when, what they see, and
// every time they looked. Stop sharing is one tap (it only reduces access).
// With no trainer, this is where a code is entered: ShareApprove, as the
// profile this app is already in. The name comes from P.getActive() and is
// never typed.
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

const LOG_SHOWN = 20;
const OFFLINE = "Couldn't reach Heatwayve. Try again.";
const NOT_STOPPED = "That didn't go through. Try again.";
const SIGN_IN = "Sign in again to see your trainer.";
const WENT_WRONG = "Something went wrong. Try again.";
const focusOnMount = (el) => { el?.focus(); };

const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
// Roster looks carry a London calendar day ("2026-09-29"), read as that day.
const dayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const londonDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

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
    const res = await fetchWithTimeout(`/api/sync/trainer?profile=${encodeURIComponent(profile)}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, body };
    return { ok: false, error: res.status === 429 ? APPROVE_COPY.slowDown : res.status === 401 ? SIGN_IN : WENT_WRONG };
  } catch {
    return { ok: false, error: OFFLINE };
  }
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

  // "Got it": the notice goes now. Write: POST { seen } -> dbSeenEndedNotice,
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

  const kicker = <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>Your trainer</div>;
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
              <p style={line}>Sees your sessions, sets and how you felt for the last 24 weeks, and your main-lift trend and bests for 12 months. Read only.</p>
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
          {/* Paused: a fresh code from them (or someone new) goes in here. */}
          {!sharing.live && body.open && (
            <div style={{ marginTop: 20 }}>
              <ShareApprove key={approveKey} name={current} level={2} onApproved={onApproved} onDone={toProfile} onCancel={onPausedCancel}
                lead={<p style={{ ...line, color: T.ink }}>Got a fresh code from {who}?</p>} />
            </div>
          )}
        </Fade>

        <Fade d={80}>
          <div style={{ marginTop: 28, marginBottom: 6, fontSize: 13, color: T.ink2 }}>When {who} looked</div>
          <p style={{ fontSize: 12, color: T.ink2, lineHeight: 1.6, margin: "0 0 10px" }}>
            Looking at your training opens your sessions and lifts. A roster check-in is {who}&apos;s client list showing when you last trained and your sessions this week. It shows here once a day.
          </p>
          {looks.length ? (
            <ul aria-label={`When ${who} looked`} style={{ listStyle: "none", margin: 0, padding: 0, borderTop: `1px solid ${T.rule}` }}>
              {looks.map((l, i) => (
                <li key={`${l.at}-${i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "12px 2px", borderBottom: `1px solid ${T.rule}` }}>
                  <span style={{ fontSize: 14, color: T.ink, minWidth: 0, overflowWrap: "anywhere" }}>
                    {l.kind === "roster" ? `${who} checked in on the roster` : `${who} looked at your training`}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 12, color: T.ink2 }}>
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
            Got it
          </button>
        )}
      </div>
    ) : null;
    content = (
      <Fade d={0}>
        {kicker}
        {body.open ? (
          // ShareApprove carries the page heading: "Add a trainer", then whose code it is.
          <ShareApprove name={current} title="Add a trainer" lead={notice} onDone={toProfile} onCancel={toProfile} />
        ) : notice || (
          <p tabIndex={-1} ref={seen ? focusOnMount : undefined} style={{ ...line, outline: "none" }}>No trainer sees your training.</p>
        )}
      </Fade>
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
