"use client";

// components/TrainerClientView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// One client's training, as their trainer sees it: the pane of /trainer.
// With `self`, the trainer's own training through the same projection: no
// sharing dates, no looks, nothing to stop. Read only. Every number is computed here from the projection the trainer
// routes send (lib/trainer-view.js projectForTrainer), with the same pure
// functions the client's own Lab uses. Nothing about the viewer's own device
// is read. Sessions carry synthetic ids, so nothing here parses an id as a
// time.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { useInlineModalA11y } from "@/lib/a11y";
import Glyph from "@/components/Glyph";
import { InkSpark, LineChart } from "@/components/LiftCharts";
import { mainLiftTrend, readinessBreakdown } from "@/lib/analytics";
import { auditHistoryVolume, AUDIT_MUSCLE_ORDER } from "@/lib/volume-audit";
import { makeDayContext, weeklyStrength } from "@/lib/day-state";
import { isResting } from "@/lib/breaks";
import { runsWeekFor } from "@/lib/trainer-view";

const PAGE = 10;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAND = { fresh: "Fresh", normal: "Normal", cooked: "Cooked" };

/** Screen-reader-only text. */
const SR_ONLY = /** @type {import("react").CSSProperties} */ ({
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
});

/** "29 Sep" from an ISO date. @param {string} iso */
export function isoDayMonth(iso) {
  const [, m, d] = String(iso).split("-").map(Number);
  return m && d ? `${d} ${MON[m - 1]}` : "";
}

/** "Mon 29 Sep" from an ISO date. @param {string} iso */
export function isoDayLabel(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`;
}

/** "3 Oct" from epoch ms, in the viewer's own calendar. @param {number} ms */
export function msDayMonth(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MON[d.getMonth()]}` : "";
}

/** "2 hours ago". Local, so this pane pulls in nothing server-side. */
export function agoText(ms, now) {
  if (!ms || !now) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24); return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Numbers in a line set in the measured face, words left in the text face. @param {{ text: string }} props */
export function Nums({ text }) {
  const parts = String(text).split(/(\d+(?:\.\d+)?)/);
  return parts.map((p, i) => (i % 2 === 1
    ? <span key={i} style={{ fontFamily: T.measured }}>{p}</span>
    : p));
}

/** A rhythm cell's words: house copy, not the AI formatter. */
export function rhythmCellText(w) {
  if (w.planned === 0 && w.plannedResting > 0) return "paused";
  if (w.partial) return `${w.done} of ${w.plannedSoFar} so far`;
  if (w.plannedResting > 0) return `${w.done}/${w.planned} · part paused`;
  return `${w.done}/${w.planned}`;
}

const isBodyweight = (s, ex) => (s?.loadType ?? ex?.loadType) === "bodyweight";
const counted = (s) => s && (s.weight != null || (s.reps != null && s.reps !== ""));

/**
 * One exercise's sets: "100 × 5, 5, 5 · RPE 8, 8, 8.5". Bodyweight sets
 * read as reps, or "+10 kg × 8, 8" when added kg is proven (the projection
 * ships 0 otherwise). A set with no RPE but a RIR reads "RIR 2".
 */
export function setsLine(ex) {
  const sets = (Array.isArray(ex?.sets) ? ex.sets : []).filter(counted);
  if (!sets.length) return null;
  const reps = sets.map((s) => (s.reps == null || s.reps === "" ? "–" : String(s.reps)));
  const load = sets.map((s) => {
    const w = typeof s.weight === "number" ? s.weight : null;
    if (isBodyweight(s, ex)) return w && w > 0 ? `+${w} kg` : null;
    return w;
  });
  let work;
  if (load.every((l) => l === null)) work = reps.join(", ");
  else if (load.every((l) => l === load[0])) work = `${load[0]} × ${reps.join(", ")}`;
  else work = sets.map((_, i) => (load[i] === null ? reps[i] : `${load[i]} × ${reps[i]}`)).join(", ");

  const effort = sets.map((s) => (typeof s.rpe === "number" ? { k: "RPE", v: s.rpe } : typeof s.rir === "number" ? { k: "RIR", v: s.rir } : null));
  const known = effort.filter(Boolean);
  let feel = "";
  if (known.length) {
    const one = known.every((e) => e.k === known[0].k) && known.length === effort.length;
    feel = one
      ? `${known[0].k} ${known.map((e) => e.v).join(", ")}`
      : effort.map((e) => (e ? `${e.k} ${e.v}` : "–")).join(", ");
  }
  return feel ? `${work} · ${feel}` : work;
}

/** The point with the highest e1RM, first on ties. */
function bestOf(points) {
  let best = null;
  for (const p of points || []) if (!best || p.est1RM > best.est1RM) best = p;
  return best;
}

/** @type {import("react").CSSProperties} */
const kicker = { fontSize: 13, color: T.ink3, paddingBottom: 8, borderBottom: `1px solid ${T.rule}`, marginBottom: 12 };
/** @type {import("react").CSSProperties} */
const section = { marginTop: 32 };
/** @type {import("react").CSSProperties} */
const quietBtn = {
  background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 14, color: T.ink2, height: 44, padding: "0 16px",
};

/**
 * @param {{
 *   client: { name: string | null, since?: number | null },
 *   view: any,
 *   lastLooked?: number | null,
 *   now?: number,
 *   onRemove?: () => Promise<boolean> | boolean | void,
 *   self?: boolean,
 * }} props
 */
export default function TrainerClientView({ client, view, lastLooked = null, now = 0, onRemove, self = false }) {
  const name = client?.name || null;
  const title = self ? "You" : name || "Your client";
  const they = self ? "you" : "they";
  const todayIso = view?.window?.to;
  const from = view?.window?.from;
  const sessions = useMemo(() => (Array.isArray(view?.sessions) ? view.sessions : []), [view]);
  const tops = useMemo(() => (Array.isArray(view?.tops) ? view.tops : []), [view]);
  const breaks = useMemo(() => (Array.isArray(view?.breaks) ? view.breaks : []), [view]);

  const resting = isResting(breaks);
  const weeks = useMemo(() => (todayIso
    ? weeklyStrength(makeDayContext({ todayIso, history: sessions, breaks, weekFor: runsWeekFor(view?.schedule) }), { weeks: 24 })
    : []), [todayIso, sessions, breaks, view]);
  // The line leaves cooked sessions out, as the Lab does; the bests count them.
  const line = useMemo(() => mainLiftTrend([...tops, ...sessions]), [tops, sessions]);
  const all = useMemo(() => mainLiftTrend([...tops, ...sessions], { includeCooked: true }), [tops, sessions]);
  const lifts = Object.keys(all);
  const felt = useMemo(() => readinessBreakdown(sessions), [sessions]);
  const audit = useMemo(() => auditHistoryVolume(sessions, { weeks: 2 }), [sessions]);
  const under = audit && !audit.away
    ? AUDIT_MUSCLE_ORDER.filter((m) => audit.perMuscle?.[m]?.status === "under_mev")
    : [];

  const [earlier, setEarlier] = useState(false);
  const [openLift, setOpenLift] = useState(null);
  const shownLift = openLift && lifts.includes(openLift) ? openLift : lifts[0];
  const [shown, setShown] = useState(PAGE);
  const newestFirst = useMemo(() => [...sessions].reverse(), [sessions]);

  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const closeConfirm = () => { if (!removing) { setConfirming(false); setStopFailed(false); } };
  const { containerRef, onKeyDown } = useInlineModalA11y(confirming, closeConfirm);
  // False from onRemove: it didn't go through, so the sheet stays and says so.
  const onStop = async () => {
    if (removing) return;
    setRemoving(true); setStopFailed(false);
    const ok = await onRemove?.();
    setRemoving(false);
    if (ok === false) setStopFailed(true);
    else setConfirming(false);
  };

  const looked = self ? null : agoText(lastLooked, now);
  const since = self ? null : client?.since;
  const sentenceName = name || "They";

  return (
    <div style={{ fontFamily: T.text, color: T.ink }}>
      {/* 1. Header */}
      <div style={{ fontSize: 13, color: T.ink2, marginBottom: 8 }}>{self ? "Your training" : "Shared with you"}</div>
      <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 10px", overflowWrap: "anywhere" }}>{title}</h1>
      <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: 0 }}>
        Read only. Sessions from the last 24 weeks; main lifts over 12 months.
      </p>
      <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "6px 0 0" }}>
        {since ? <>Sharing since <Nums text={msDayMonth(since)}/></> : null}
        {since && looked ? " · " : null}
        {looked ? <>You last looked <Nums text={looked}/></> : null}
      </p>

      <div className="forge-wide-pane">
        <div>
          {/* 2. Breather: never a reason */}
          {resting && (
            <div style={section} data-section="breather">
              <div style={{ fontSize: 13, color: T.ink3, marginBottom: 4 }}>On a breather</div>
              <div style={{ fontSize: 14, color: T.ink2, lineHeight: 1.5 }}>Paused for now. {self ? "Your" : "Their"} numbers are holding.</div>
            </div>
          )}

          {/* 3. Rhythm: the screen's one heat system */}
          <div style={section} data-section="rhythm">
            <div style={kicker}>Rhythm, last <Nums text="24"/> weeks</div>
            <ol className="forge-wide-rhythm" data-earlier={earlier ? "" : undefined} aria-label="Weekly sessions against plan, oldest first">
              {weeks.map((w, i) => (
                <RhythmCell key={w.mondayIso} week={w} early={i < weeks.length - 8}/>
              ))}
            </ol>
            {/* The tier classes sit on wrappers: an inline display would beat them. */}
            <div className="forge-wide-n-only">
              <button type="button" aria-expanded={earlier} onClick={() => setEarlier((v) => !v)}
                style={{ background: "none", border: "none", padding: "10px 0 0", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2, display: "inline-flex", alignItems: "center", gap: 5 }}>
                {earlier ? "Fewer weeks" : "Earlier weeks"}
                <Glyph name={earlier ? "chevronUp" : "chevronDown"} size={11} color={T.ink3}/>
              </button>
            </div>
            {weeks.length > 0 && (
              <div style={{ fontSize: 12, color: T.ink3, marginTop: 8 }}>
                Oldest first, from the week of <Nums text={isoDayMonth(weeks[0].mondayIso)}/>.
              </div>
            )}
          </div>

          {/* 4. Main lifts: the 12-month line and the bests */}
          <div style={section} data-section="lifts">
            <div style={kicker}>Main lifts</div>
            {lifts.length === 0 && (
              <div style={{ fontSize: 13, color: T.ink2 }}>No main-lift sessions in the last 12 months.</div>
            )}
            {lifts.map((lift) => (
              <LiftBlock key={lift} lift={lift} line={line[lift] || []} points={all[lift] || []} from={from}
                open={shownLift === lift} onOpen={() => setOpenLift(lift)}/>
            ))}
          </div>
        </div>

        <div>
          {/* 5. How they felt: always shown */}
          <div style={section} data-section="felt">
            <div style={kicker}>How {they} felt</div>
            {felt.total > 0 ? (
              <div style={{ fontSize: 14, color: T.ink }}>
                <Nums text={`Fresh ${felt.fresh} · Normal ${felt.normal} · Cooked ${felt.cooked}`}/>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T.ink2 }}>Nothing logged in the last 24 weeks.</div>
            )}
            <div style={{ fontSize: 12, color: T.ink3, marginTop: 6 }}>Each session shows how {they} felt; sets show RPE or RIR.</div>
          </div>

          {/* 6. Under minimum: only when flagged */}
          {under.length > 0 && (
            <div style={section} data-section="under">
              <div style={kicker}>Under minimum</div>
              <div style={{ fontSize: 14, color: T.ink2, lineHeight: 1.5 }}>
                <span style={{ color: T.under }}>{under.slice(0, 3).join(", ")}</span>: under minimum, last <Nums text="2"/> weeks
              </div>
            </div>
          )}

          {/* 7. Sessions: the 24-week detail tier, newest first */}
          <div style={section} data-section="sessions">
            <div style={kicker}>Sessions</div>
            {newestFirst.length === 0 && (
              <div style={{ fontSize: 13, color: T.ink2 }}>No sessions in the last 24 weeks.</div>
            )}
            {newestFirst.slice(0, shown).map((s) => <SessionRow key={s.id} session={s}/>)}
            {newestFirst.length > shown && (
              <button type="button" onClick={() => setShown((n) => n + PAGE)} className="forge-press forge-tint"
                style={{ ...quietBtn, width: "100%", marginTop: 12 }}>
                Show earlier
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 8. Footer: a client's only. Nothing to stop on your own. */}
      {!self && (
        <div style={{ marginTop: 40, paddingTop: 16, borderTop: `1px solid ${T.rule}` }}>
          <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "0 0 12px" }}>
            Read only. {sentenceName} can stop sharing any time.
          </p>
          <button type="button" onClick={() => setConfirming(true)} className="forge-press forge-tint" style={quietBtn}>
            {name ? `Stop seeing ${name}'s training` : "Stop seeing their training"}
          </button>
        </div>
      )}

      {confirming && !self && (
        <div onKeyDown={onKeyDown} onClick={closeConfirm} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="trainer-stop-title" tabIndex={-1}
            onClick={(e) => e.stopPropagation()} className="forge-sheet-ground forge-vellum"
            style={{ padding: "26px 24px calc(24px + env(safe-area-inset-bottom))", width: "100%", animation: `slideUp 260ms ${T.ease}`, boxSizing: "border-box", outline: "none" }}>
            <div id="trainer-stop-title" style={{ fontSize: 18, fontWeight: 500, color: T.ink, lineHeight: 1.3, marginBottom: 10 }}>
              {name ? `Stop seeing ${name}'s training?` : "Stop seeing their training?"}
            </div>
            <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.55, margin: "0 0 22px" }}>
              They'll see you ended it. To see it again, they'd approve a new code.
            </p>
            <button type="button" onClick={onStop} aria-disabled={removing}
              style={{ width: "100%", height: 52, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong, opacity: removing ? 0.6 : 1 }}>
              {removing ? "One moment" : "Stop"}
            </button>
            <div role="status" aria-live="polite" style={{ fontSize: 12, color: T.ink2, marginTop: 8, minHeight: 16, textAlign: "center" }}>
              {stopFailed ? "Couldn't stop that just now. Try again." : ""}
            </div>
            <button type="button" onClick={closeConfirm}
              style={{ width: "100%", padding: "12px", marginTop: 4, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.ink3, fontFamily: T.text }}>
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// One week. Filled on the thermal ramp by the share of the plan done; a
// week a breather took entirely reads as rest. The words are printed, so the
// colour carries nothing on its own.
function RhythmCell({ week, early }) {
  const text = rhythmCellText(week);
  const paused = week.planned === 0 && week.plannedResting > 0;
  const due = week.partial ? week.plannedSoFar : week.planned;
  const ratio = due > 0 ? Math.min(1, week.done / due) : week.done > 0 ? 1 : 0;
  const step = paused || ratio === 0 ? null : ratio >= 1 ? 3 : ratio >= 0.5 ? 2 : 1;
  const [figure, note] = paused ? ["", "paused"]
    : week.partial ? [`${week.done} of ${week.plannedSoFar}`, "so far"]
    : week.plannedResting > 0 ? [`${week.done}/${week.planned}`, "part paused"]
    : [`${week.done}/${week.planned}`, ""];
  return (
    <li className={early ? "forge-wide-rhythm-early" : undefined} data-week={week.mondayIso}
      style={{
        position: "relative", boxSizing: "border-box", minWidth: 0, padding: "8px 2px", borderRadius: T.rMark,
        textAlign: "center", lineHeight: 1.2,
        background: paused ? "transparent" : step ? T.heat[step] : "transparent",
        boxShadow: step ? "none" : `inset 0 0 0 1px ${T.rule}`,
        color: step ? `var(--on-heat-${step})` : paused ? T.ink3 : T.ink2,
      }}>
      <span style={SR_ONLY}>Week of {isoDayMonth(week.mondayIso)}: {text}</span>
      <span aria-hidden="true" style={{ display: "block" }}>
        {figure && <span style={{ display: "block", fontFamily: T.measured, fontSize: 12 }}>{figure}</span>}
        {/* Breaks between words only: "paused" never splits. */}
        {note && <span style={{ display: "block", fontSize: 10, marginTop: figure ? 2 : 0 }}>{note}</span>}
      </span>
    </li>
  );
}

// One main lift. Under 640 a row with a sparkline that opens its chart (one
// open at a time, as in the Lab); from 640 every chart shows.
function LiftBlock({ lift, line, points, from, open, onOpen }) {
  const best = bestOf(points);
  const last = points[points.length - 1];
  const recent = from ? points.filter((p) => p.date >= from).length : points.length;
  const latest = (line.length ? line : points)[(line.length ? line : points).length - 1];
  return (
    <div className="forge-wide-lift" data-open={open ? "" : undefined} style={{ borderTop: `1px solid ${T.ruleFaint}`, padding: "10px 0" }}>
      <div className="forge-wide-n-only">
        <button type="button" className="forge-press forge-tint" onClick={onOpen} aria-expanded={open}
          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "6px 0", background: "none", border: "none", cursor: "pointer", fontFamily: T.text, textAlign: "left", color: T.ink }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lift}</span>
          <InkSpark values={points.slice(-8).map((p) => p.est1RM)}/>
          {latest && <span style={{ fontFamily: T.measured, fontSize: 15, flexShrink: 0 }}>{latest.est1RM}<span style={{ fontFamily: T.text, fontSize: 11, color: T.ink3 }}> kg</span></span>}
        </button>
      </div>
      <div className="forge-wide-mw-only" style={{ fontSize: 15, fontWeight: 500, color: T.ink, padding: "6px 0" }}>{lift}</div>
      <div className="forge-wide-lift-detail" style={{ paddingTop: 6 }}>
        <LineChart series={line}/>
        <div style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6, marginTop: 10 }}>
          {best && (
            <div>Best in 12 months: <Nums text={`${best.est1RM} kg e1RM · ${best.topSet.weight} × ${best.topSet.reps} · ${isoDayMonth(best.date)}`}/></div>
          )}
          {last && <div>Last top set: <Nums text={`${last.topSet.weight} × ${last.topSet.reps}`}/></div>}
          <div><Nums text={`${recent} session${recent === 1 ? "" : "s"} in the last 24 weeks`}/></div>
        </div>
      </div>
    </div>
  );
}

function SessionRow({ session }) {
  const head = [isoDayLabel(session.date), session.scheduledLetter, BAND[session.readiness] || "Readiness not logged"]
    .filter(Boolean).join(" · ");
  const rows = [];
  for (const b of session.blocks || []) {
    for (const ex of b?.exercises || []) {
      const text = setsLine(ex);
      if (text) rows.push({ name: ex.name || "Exercise", text });
    }
  }
  return (
    <div data-session={session.date} style={{ borderTop: `1px solid ${T.ruleFaint}`, padding: "12px 0" }}>
      <div style={{ fontSize: 15, fontWeight: 500, color: T.ink }}><Nums text={head}/></div>
      {session.travel === true && <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>Travel session</div>}
      {rows.map((r, i) => (
        <div key={i} style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, marginTop: 4 }}>
          <span style={{ color: T.ink }}>{r.name}</span> · <Nums text={r.text}/>
        </div>
      ))}
    </div>
  );
}
