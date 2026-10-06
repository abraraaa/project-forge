"use client";

// components/TrainerClientView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// One client's training, as their trainer sees it: the pane of /trainer.
// With `self`, the trainer's own training through the same projection: no
// sharing dates, no looks, nothing to stop. When the client has the trainer's
// changes on, the view carries their plan: the trainer can change it, and
// the client sees every change and can undo it (the plan section below).
// Otherwise read only. Every number is computed here from the projection the trainer
// routes send (lib/trainer-view.js projectForTrainer), with the same pure
// functions the client's own Lab uses. Nothing about the viewer's own device
// is read. Sessions carry synthetic ids, so nothing here parses an id as a
// time.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { useInlineModalA11y } from "@/lib/a11y";
import Glyph from "@/components/Glyph";
import { InkSpark, LineChart } from "@/components/LiftCharts";
import { mainLiftTrend, readinessBreakdown } from "@/lib/analytics";
import { auditHistoryVolume, AUDIT_MUSCLE_ORDER } from "@/lib/volume-audit";
import { makeDayContext, weeklyStrength } from "@/lib/day-state";
import { isResting } from "@/lib/breaks";
import { localDateStr, todayLocalIso } from "@/lib/dates";
import { runsWeekFor, SELF_REF } from "@/lib/trainer-view";
import { ledgerFor, ledgerKg, ledgerReps, ledgerRepsText, ledgerSetText, ledgerVolumeText, ledgerSetsShown } from "@/lib/trainer-ledger";
import { exportFilename } from "@/lib/trainer-export";
import { MAX_OPS, MAX_KG, REP_LIMITS, TIMED_SECONDS, WEEK_JUMP_FRACTION, BIG_DROP_FRACTION } from "@/lib/trainer-change";
import { EFFECTIVE_REP_BAND } from "@/lib/rep-band";
import { nextRung, snapToImplement, isBodyweightMovement } from "@/lib/lift-translations";
import { timedTargetFor } from "@/lib/programme";

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
 *   onChange?: (body: any) => Promise<{ status: number, body: any }>,
 *   onFaceId?: () => Promise<boolean>,
 *   onChanged?: () => Promise<unknown> | unknown,
 *   clientRef?: string | null,
 *   onExport?: (body: { ref: string, today: string }) => Promise<Response | null | undefined>,
 * }} props
 * clientRef is the ref the parent opened this pane by (a client's; your own
 * training is "me"). onExport posts the body to /api/trainer/export through
 * the parent's fetch, as onChange does, and hands back the raw response; the
 * pane saves it as a file. The ref rides in the body, never a URL.
 * onChange posts to /api/trainer/change for this client (the parent adds
 * the grant and the date); onFaceId runs the trainer's sign-in again for a
 * fresh Face ID; onChanged reloads the pane after a send or a withdraw, and
 * answers false when the reload didn't land.
 */
export default function TrainerClientView({ client, view, lastLooked = null, now = 0, onRemove, self = false, onChange, onFaceId, onChanged, clientRef = null, onExport }) {
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
  // Each main lift's ledger: every set over 24 weeks, then top sets to 12 months.
  const ledgers = useMemo(() => Object.fromEntries(Object.keys(all).map((l) => [l, ledgerFor(view, l)])), [view, all]);
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
  // The plan comes only for a client who has the trainer's changes on.
  const plan = !self && view?.plan && typeof view.plan === "object" ? view.plan : null;
  // Where their changes stand (view.edits); "on" without a plan means it couldn't be read.
  const edits = plan ? "on" : view?.edits === "on" ? "unavailable" : view?.edits;
  const lead = self ? "Read only." : leadLine(edits, name);
  // The export: a client's (the pane only renders while the grant is live) or
  // your own, which the route serves as "me".
  const exportRef = self ? SELF_REF : typeof clientRef === "string" && clientRef ? clientRef : null;
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const onDownload = async () => {
    if (exporting || !exportRef || !onExport) return;
    setExporting(true); setExportFailed(false);
    const ok = await downloadCsv(onExport, exportRef, self ? SELF_REF : "", name);
    setExporting(false);
    if (!ok) setExportFailed(true);
  };

  return (
    <div style={{ fontFamily: T.text, color: T.ink }}>
      {/* 1. Header */}
      <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>{self ? "Your training" : "Shared with you"}</div>
      <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 10px", overflowWrap: "anywhere" }}>{title}</h1>
      <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: 0 }}>
        {lead} Sessions from the last 24 weeks; main lifts over 12 months.
      </p>
      <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "6px 0 0" }}>
        {since ? <>Sharing since <Nums text={msDayMonth(since)}/></> : null}
        {since && looked ? " · " : null}
        {looked ? <>You last looked <Nums text={looked}/></> : null}
      </p>
      {exportRef && onExport && (
        <div data-export="" style={{ marginTop: 4 }}>
          <button type="button" onClick={onDownload} aria-disabled={exporting}
            style={{ display: "inline-block", padding: "12px 0", lineHeight: "20px", background: "none", border: "none", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2, textDecoration: "underline", textUnderlineOffset: 3 }}>
            Download CSV
          </button>
          <div role="status" aria-live="polite" style={statusLine}>{exportFailed ? EXPORT_FAILED : ""}</div>
        </div>
      )}

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

          {/* 3b. Plan: only when the client has the trainer's changes on */}
          {plan && <PlanSection plan={plan} name={name} onChange={onChange} onFaceId={onFaceId} onChanged={onChanged}/>}

          {/* 4. Main lifts: the 12-month line and the bests */}
          <div style={section} data-section="lifts">
            <div style={kicker}>Main lifts</div>
            {lifts.length === 0 && (
              <div style={{ fontSize: 13, color: T.ink2 }}>No main-lift sessions in the last 12 months.</div>
            )}
            {lifts.map((lift) => (
              <LiftBlock key={lift} lift={lift} line={line[lift] || []} points={all[lift] || []} from={from}
                ledger={ledgers[lift] || []} open={shownLift === lift} onOpen={() => setOpenLift(lift)}/>
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
              <button type="button" onClick={() => setShown((n) => n + PAGE)} className="forge-press forge-tint" aria-label="Show earlier sessions"
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
            {edits === "on" || edits === "unavailable" ? "" : "Read only. "}{sentenceName} can stop sharing any time.
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
  // "so far" and "part paused" don't fit a narrow cell at 12px: they live
  // in the screen-reader line, and the cell shows the figure alone. A paused
  // week's only mark is its word, set at 10px with no side padding so it
  // stays inside the cell's border (12px "paused" is ~39px; a 390 cell ~35).
  const [figure, note] = paused ? ["", "paused"]
    : week.partial ? [`${week.done}/${week.plannedSoFar}`, ""]
    : [`${week.done}/${week.planned}`, ""];
  return (
    <li className={early ? "forge-wide-rhythm-early" : undefined} data-week={week.mondayIso}
      style={{
        position: "relative", boxSizing: "border-box", minWidth: 0, padding: paused ? "8px 0" : "8px 2px", borderRadius: T.rMark,
        textAlign: "center", lineHeight: 1.2,
        background: paused ? "transparent" : step ? T.heat[step] : "transparent",
        border: `1px solid ${step ? "transparent" : T.rule}`,
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
// open at a time, as in the Lab); from 640 every chart shows. Its ledger
// sits under the bests.
function LiftBlock({ lift, line, points, from, ledger, open, onOpen }) {
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
        <LiftLedger lift={lift} rows={ledger} from={from}/>
      </div>
    </div>
  );
}

// ── The export ──────────────────────────────────────────────────────────────

const EXPORT_FAILED = "Couldn't download just now.";
/** How long the saved file's object URL lives: long enough for a slow browser to start the save. */
const REVOKE_AFTER_MS = 10_000;

/**
 * The file name the route sent (Content-Disposition), when it is a plain
 * .csv name; otherwise null.
 * @param {string | null} header
 */
export function exportNameFrom(header) {
  const m = typeof header === "string" ? header.match(/filename="([^"]*)"/i) : null;
  return m && /^[A-Za-z0-9._-]{1,120}\.csv$/.test(m[1]) ? m[1] : null;
}

/**
 * POST the export through the parent and save what comes back as a file.
 * True when the file was handed to the browser; any failure is false, and
 * the server's words are never read.
 * @param {(body: { ref: string, today: string }) => Promise<Response | null | undefined>} onExport
 * @param {string} ref
 * @param {string} fallbackRef  what the fallback name may use in place of a handle: "me" or nothing, never a grant ref
 * @param {string | null} name
 */
async function downloadCsv(onExport, ref, fallbackRef, name) {
  const today = todayLocalIso();
  try {
    const res = await onExport({ ref, today });
    if (!res || !res.ok) return false;
    const blob = await res.blob();
    const file = exportNameFrom(res.headers.get("Content-Disposition")) ?? exportFilename(name, fallbackRef, today);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    return true;
  } catch {
    return false;
  }
}

/** Ledger sessions shown before "Show earlier". */
const LEDGER_PAGE = 10;

/** The trainer's change on a session: "You, 3 Oct" (the day it was sent). */
export function changeByText(c) {
  const day = c?.at != null ? msDayMonth(c.at) : "";
  return day ? `You, ${day}` : "You";
}

/** The same, with what it set: "Your change, 105 kg, sent 3 Oct". */
function changeDetailText(c) {
  const what = c.after == null ? "" : c.kind === "weight" ? `, ${c.after} kg` : `, ${ledgerRepsText(c.after)}`;
  const day = c.at != null ? msDayMonth(c.at) : "";
  return `Your change${what}${day ? `, sent ${day}` : ""}`;
}

/** @type {import("react").CSSProperties} */
const cell = { padding: "6px 6px 6px 0", textAlign: "left", verticalAlign: "top", fontWeight: 400 };
/** @type {import("react").CSSProperties} */
const headCell = { ...cell, fontSize: 12, color: T.ink3, borderBottom: `1px solid ${T.rule}`, whiteSpace: "nowrap" };

/**
 * One main lift's ledger, newest first (lib/trainer-ledger.js): top sets or
 * every set. Under 640 a compact row per session (date · best set · volume)
 * that opens to its sets, every row open under All sets; from 640 a table.
 * Both are rendered and the tier classes pick one, as the lift rows do.
 * A set the view carries no kg for shows its reps alone.
 */
function LiftLedger({ lift, rows, from }) {
  const [mode, setMode] = useState(/** @type {"top" | "all"} */ ("top"));
  // Rows tapped away from the mode's default: closed under Top sets, open under All sets.
  const [flipped, setFlipped] = useState(() => /** @type {Set<string>} */ (new Set()));
  const [shown, setShown] = useState(LEDGER_PAGE);
  const page = rows.slice(0, shown);
  const firstTop = page.findIndex((r) => r.tier === "top");
  const recent = rows.some((r) => r.tier === "session");
  const prescribed = rows.some((r) => r.prescribed != null);
  const anyChange = rows.some((r) => r.changes.length > 0);
  const pick = (m) => { setMode(m); setFlipped(new Set()); };
  const flip = (key) => setFlipped((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const olderText = from ? `Before ${isoDayMonth(from)}: top sets only.` : "Older: top sets only.";
  const cols = 3 + (mode === "all" ? 2 : 0) + (prescribed ? 1 : 0) + (anyChange ? 1 : 0) + 1;

  return (
    <div data-ledger={lift} style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 13, color: T.ink3 }}>Ledger</div>
        <div role="group" aria-label={`${lift} ledger sets`} style={{ display: "flex", gap: 6 }}>
          <button type="button" aria-pressed={mode === "top"} aria-label={`Top sets for ${lift}`} onClick={() => pick("top")} style={chip(mode === "top")}>Top sets</button>
          <button type="button" aria-pressed={mode === "all"} aria-label={`All sets for ${lift}`} onClick={() => pick("all")} style={chip(mode === "all")}>All sets</button>
        </div>
      </div>
      {!recent && (
        <div data-ledger-empty="" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, marginBottom: 8 }}>Nothing logged for this lift in the last 24 weeks.</div>
      )}

      {/* Under 640: a compact row per session. */}
      <div className="forge-wide-n-only" data-ledger-narrow="">
        {page.map((r, i) => {
          const open = (mode === "all") !== flipped.has(r.key);
          const summary = [isoDayMonth(r.date), ledgerSetText(r.best), r.tier === "top" ? "top set only" : ledgerVolumeText(r.volume)]
            .filter(Boolean).join(" · ");
          return (
            <Fragment key={r.key}>
              {i === firstTop && <div data-ledger-older="" style={{ fontSize: 12, color: T.ink3, padding: "10px 0 4px" }}><Nums text={olderText}/></div>}
              <div data-ledger-row={r.key} data-tier={r.tier} style={{ borderTop: `1px solid ${T.ruleFaint}` }}>
                <button type="button" aria-expanded={open} onClick={() => flip(r.key)} className="forge-press forge-tint"
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 44, padding: "8px 0", background: "none", border: "none", cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink, textAlign: "left" }}>
                  <span style={{ flex: 1, minWidth: 0 }}><Nums text={summary}/></span>
                  {r.changes.length > 0 && <span style={{ fontSize: 12, color: T.ink3, flexShrink: 0 }}>Your change</span>}
                  <Glyph name={open ? "chevronUp" : "chevronDown"} size={11} color={T.ink3}/>
                </button>
                {open && (
                  <div data-ledger-sets="" style={{ padding: "0 0 10px" }}>
                    {r.prescribed != null && (
                      <div style={{ fontSize: 12, color: T.ink3, marginBottom: 2 }}><Nums text={`Prescribed ${ledgerRepsText(r.prescribed)}`}/></div>
                    )}
                    {r.sets.map((s) => (
                      <div key={s.n} data-ledger-set={s.n} style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6 }}>
                        <Nums text={`Set ${s.n} · ${ledgerSetText(s)}`}/>
                        {s.top && <span style={{ color: T.ink }}> · Top</span>}
                      </div>
                    ))}
                    {r.changes.map((c, k) => (
                      <div key={k} data-ledger-change="" style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}><Nums text={changeDetailText(c)}/></div>
                    ))}
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* From 640: the table. */}
      <div className="forge-wide-mw-only" data-ledger-wide="" style={{ overflowX: "auto" }}>
        {page.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, color: T.ink2 }}>
            <caption style={SR_ONLY}>{lift}, {mode === "top" ? "top sets" : "every set"}, newest first</caption>
            <thead>
              <tr>
                <th scope="col" style={headCell}>Date</th>
                {mode === "all" && <th scope="col" style={headCell}>Set</th>}
                {prescribed && <th scope="col" style={headCell}>Prescribed</th>}
                <th scope="col" style={headCell}>Reps</th>
                <th scope="col" style={headCell}>kg</th>
                {mode === "all" && <th scope="col" style={headCell}><span style={SR_ONLY}>Top set</span></th>}
                <th scope="col" style={headCell}>Volume</th>
                {anyChange && <th scope="col" style={headCell}>Change</th>}
              </tr>
            </thead>
            {page.map((r, i) => {
              const sets = ledgerSetsShown(r, mode);
              return (
                <Fragment key={r.key}>
                  {i === firstTop && (
                    <tbody data-ledger-older="">
                      <tr><td colSpan={cols} style={{ ...cell, fontSize: 12, color: T.ink3, paddingTop: 12 }}><Nums text={olderText}/></td></tr>
                    </tbody>
                  )}
                  <tbody data-ledger-row={r.key} data-tier={r.tier}>
                    {sets.map((s, j) => (
                      <tr key={s.n} data-ledger-set={s.n} style={{ borderTop: j === 0 ? `1px solid ${T.ruleFaint}` : "none" }}>
                        {j === 0 && <th scope="rowgroup" rowSpan={sets.length} style={{ ...cell, color: T.ink, whiteSpace: "nowrap" }}><Nums text={isoDayMonth(r.date)}/></th>}
                        {mode === "all" && <td style={{ ...cell, fontFamily: T.measured }}>{s.n}</td>}
                        {prescribed && <td style={{ ...cell, fontFamily: T.measured }}>{j === 0 && r.prescribed != null ? ledgerReps(r.prescribed) : ""}</td>}
                        <td style={{ ...cell, fontFamily: T.measured, color: T.ink }}>{ledgerReps(s.reps) || "–"}</td>
                        <td style={{ ...cell, fontFamily: T.measured, color: T.ink }}>{ledgerKg(s) || "–"}</td>
                        {mode === "all" && <td style={{ ...cell, fontSize: 12, color: T.ink }}>{s.top ? "Top" : ""}</td>}
                        {j === 0 && (
                          <td rowSpan={sets.length} style={{ ...cell, whiteSpace: r.volume?.kg != null ? "nowrap" : "normal" }}>
                            {r.tier === "top" ? <span style={{ fontSize: 12, color: T.ink3 }}>top set only</span> : <Nums text={ledgerVolumeText(r.volume)}/>}
                          </td>
                        )}
                        {anyChange && j === 0 && (
                          <td rowSpan={sets.length} style={{ ...cell, fontSize: 12 }}>
                            {/* One line per day sent: a weight and reps sent together read once. */}
                            {[...new Set(r.changes.map(changeByText))].map((t) => <div key={t} data-ledger-change=""><Nums text={t}/></div>)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Fragment>
              );
            })}
          </table>
        )}
      </div>

      {rows.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + LEDGER_PAGE)} className="forge-press forge-tint" aria-label={`Show earlier ${lift} sessions`}
          style={{ ...quietBtn, width: "100%", marginTop: 10 }}>
          Show earlier
        </button>
      )}
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

// ── The plan: what a trainer may change, when the client has changes on ─────
//
// Nothing here writes on its own. Changes are drafted on this device, checked
// by POST /api/trainer/change as a dry run (the validator the client's app
// re-runs), and sent only from the review sheet once that check passes. The
// client's app applies a sent change on its next open; they see it and can
// undo it.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Changes shown before "Show earlier", in sets. */
const SETS_PAGE = 5;

/** A change set's id: minted when the review opens, so a double tap sends one set. */
export function mintSetId() {
  const bytes = new Uint8Array(26);
  globalThis.crypto.getRandomValues(bytes);
  return `hws_${Array.from(bytes, (b) => B32[b & 31]).join("")}`;
}

/** "Mon 12 Oct" from epoch ms, in the viewer's own calendar. @param {number} ms */
function msDayLabel(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? isoDayLabel(localDateStr(d)) : "";
}

/** The leading count of a rep value: 8, "8", "8/leg", "45s" → 8. */
function repCount(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = typeof v === "string" ? v.match(/^\s*(\d+)/) : null;
  return m ? parseInt(m[1], 10) : null;
}

const isTimed = (name) => timedTargetFor(name) !== null;
const perLeg = (v) => typeof v === "string" && /\/leg$/.test(v);

/** Reps as words: "5 reps", "8 reps a leg", "45 s". */
function repsWords(v, timed) {
  const n = repCount(v);
  if (n === null) return "";
  if (timed) return `${n} s`;
  return perLeg(v) ? `${n} reps a leg` : `${n} rep${n === 1 ? "" : "s"}`;
}

/** Reps after a weight: "× 5", "× 8/leg", "× 45 s". */
function repsAfterKg(v, timed) {
  const n = repCount(v);
  if (n === null) return "";
  return timed ? ` × ${n} s` : perLeg(v) ? ` × ${n}/leg` : ` × ${n}`;
}

/**
 * A lift's plan row: "last 100 × 5 · next 102.5 × 5 · yours 105 (waiting)".
 * @param {any} lift  a plan lift
 */
export function liftLine(lift) {
  const timed = isTimed(lift.name);
  const parts = [];
  const a = lift.anchor;
  if (!a) parts.push("not lifted yet");
  else if (a.kg != null) parts.push(`last ${a.kg}${repsAfterKg(a.reps, timed)}`);
  else if (a.reps != null) parts.push(`last ${repsWords(a.reps, timed)}`);
  parts.push(lift.w != null ? `next ${lift.w}${repsAfterKg(lift.reps, timed)}` : `next ${repsWords(lift.reps, timed)}`);
  const p = lift.pending;
  if (p && (p.w != null || p.reps != null)) {
    const yours = p.w != null ? `${p.w}${p.reps != null ? repsAfterKg(p.reps, timed) : ""}` : repsWords(p.reps, timed);
    parts.push(`yours ${yours} (waiting)`);
  }
  return parts.join(" · ");
}

/**
 * A lift never lifted: the route and their app take up to the same public
 * number (bounds.max: the larger of the category's cold-start cap and the
 * template). A cap of 0 means nothing is taken. With no cap known (an older
 * view), the route's check at review decides. The sheet and a refusal say
 * the same.
 * @param {number | null | undefined} cap
 */
export function noHistoryText(cap) {
  if (cap != null && cap <= 0) return "Not lifted yet. Their app sets the first weight.";
  return cap != null
    ? `Not lifted yet. Up to ${cap} kg for a first weight.`
    : "Not lifted yet. Review checks a first weight.";
}

/**
 * What the trainer can do here, by the view's edits status (view.edits): on
 * (the plan came), off (the client turned changes off), fresh (shared before
 * changes existed: a fresh approval is needed), unavailable (changes are on,
 * but their plan couldn't be read just now). No status (an older answer)
 * reads as off.
 * @param {string | null | undefined} edits
 * @param {string | null} name  the client's name
 */
export function leadLine(edits, name) {
  switch (edits) {
    case "on": return "You can change their plan. They see every change and can undo it.";
    case "unavailable": return "Couldn't load their plan just now. Try again in a moment.";
    case "fresh": return `Read only. ${name ? `${name} needs` : "They need"} to approve a fresh code before you can change their plan.`;
    default: return `Read only. ${name || "They"} can let you change their plan in Profile.`;
  }
}

/** Why the validator refused a change, in the pane's words. Never the server's text. */
export function refusalText(code, { lift = null, until = null, bounds = null } = {}) {
  const who = lift || "That lift";
  switch (code) {
    case "not_in_programme": return `${who} isn't in their programme now.`;
    case "bodyweight": return `${who} is bodyweight. Change its reps instead.`;
    case "timed": return `${who} is timed. Change its seconds instead.`;
    case "not_by_load": return `${who} doesn't move by weight. Change its reps instead.`;
    case "reps_only": return `${who}'s last top set has no weight to show here. Change their reps instead.`;
    case "range": return `Pick a weight up to ${MAX_KG} kg.`;
    case "off_grid": return "Pick a weight on their kit's steps.";
    case "deload": return until ? `After their deload ends, about ${isoDayMonth(until)}.` : "After their deload ends.";
    case "recovery": return `After their next ${lift || "session"} session.`;
    case "per_change": return bounds?.max != null ? `Up to ${bounds.max} kg in one change from their last top set.` : "Too big a step from their last top set.";
    case "per_week": return bounds?.max != null
      ? `Up to ${bounds.max} kg this week.`
      : `Up to ${Math.round(WEEK_JUMP_FRACTION * 100)}% a week over their top set of a week ago, or one step when that set can't be shown here.`;
    case "floor": return bounds?.min != null ? `Not below ${bounds.min} kg, their deload weight.` : "Not below their deload weight.";
    case "no_history": return noHistoryText(bounds?.max);
    case "timed_range": return `${TIMED_SECONDS.min} to ${TIMED_SECONDS.max} seconds, in steps of ${TIMED_SECONDS.step}.`;
    case "reps_range": return `${REP_LIMITS.min} to ${REP_LIMITS.max} reps.`;
    case "not_main":
    case "not_option": return "That isn't an option for this main lift.";
    case "not_yet":
    case "from_range": return "Dated changes aren't open yet.";
    default: return "That change isn't allowed.";
  }
}

/** A warning the validator raised: shown, never blocking. */
export function warningText(code) {
  switch (code) {
    case "big_drop": return `More than ${Math.round((1 - BIG_DROP_FRACTION) * 100)}% under their last top set.`;
    case "off_programme_reps": return "Outside the programme's usual reps for this lift.";
    case "below_rep_band": return `Under ${EFFECTIVE_REP_BAND.min} reps: heavier work than the programme's band.`;
    case "double_progression": return "Raises weight and reps together.";
    case "band": return "Some muscles would sit outside their weekly range with this main lift.";
    case "under_mev": return "Some muscles would sit under minimum.";
    case "over_mrv": return "Some muscles would sit over their maximum.";
    default: return null;
  }
}

const NOT_APPLIED = {
  superseded: "They trained before it arrived",
  already_there: "They were already there",
  deload: "Arrived during their deload",
  replaced: "Replaced by a newer change",
  limits: "Past the limits when it arrived",
  stopped: "Stopped before it arrived",
};

/** A change's status, in the trainer's words (lib/trainer-change.js changeStatus). */
export function trainerStatusText(c, name) {
  switch (c.status) {
    case "waiting": return c.from ? `From ${isoDayLabel(c.from)}` : `Waiting for ${name ? `${name}'s` : "their"} app`;
    case "in_force": return "In their plan";
    case "trained_yours": return `Done at your number${c.date ? `, ${isoDayMonth(c.date)}` : ""}${c.cooked ? " · cooked day" : ""}`;
    case "changed_since": return "They changed it since";
    case "undone": return `Undone by ${name || "them"}`;
    case "withdrawn": return "Withdrawn";
    default: return NOT_APPLIED[c.reason] || "Didn't arrive";
  }
}

/** Taking a change back: before it lands, or while it is in force (never a week once landed). */
const withdrawable = (c) => c.status === "waiting" || (c.status === "in_force" && c.kind !== "week");
/**
 * The rows a withdraw by set id reaches on the route (lib/trainer-changes-store.js
 * dbWithdrawChanges): not undone, and not landed, or landed and not a week.
 * That includes rows they trained at or changed since, so "Withdraw all"
 * shows only when every one of these is withdrawable.
 */
const reachedBySet = (c) => c.status === "waiting" || (c.status === "not_applied" && c.reason === "stopped")
  || (["in_force", "trained_yours", "changed_since"].includes(c.status) && c.kind !== "week");

/** One sent change: "Barbell Back Squat · 105 kg, was 102.5". */
export function changeLine(c) {
  const timed = c.kind === "reps" && isTimed(c.target);
  if (c.kind === "weight") return `${c.target} · ${c.after} kg${c.before != null ? `, was ${c.before}` : ""}`;
  if (c.kind === "reps") return `${c.target} · ${repsWords(c.after, timed)}${c.before != null ? `, was ${repCount(c.before)}` : ""}`;
  if (c.kind === "mainLift") return `Main lift · ${c.after}${c.before ? `, was ${c.before}` : ""}`;
  return c.from ? `Week from ${isoDayLabel(c.from)}` : "Week";
}

/** A drafted or previewed change, before → after. */
function previewLine(op, timed) {
  if (op.kind === "weight") return `${op.target} · ${op.before != null ? `${op.before} → ` : ""}${op.after} kg`;
  if (op.kind === "reps") return `${op.target} · ${op.before != null ? `${repCount(op.before)} → ` : ""}${repsWords(op.after, timed)}`;
  if (op.kind === "mainLift") return `Main lift · ${op.before ? `${op.before} → ` : ""}${op.after}`;
  return "Week";
}

/** The ops a set of drafts sends, main lifts first, then weights, then reps. */
export function draftOps(drafts) {
  return [
    ...Object.entries(drafts.m).map(([canonical, choice]) => ({ kind: "mainLift", canonical, choice, from: null })),
    ...Object.entries(drafts.w).map(([lift, kg]) => ({ kind: "weight", lift, kg, from: null })),
    ...Object.entries(drafts.r).map(([lift, reps]) => ({ kind: "reps", lift, reps, from: null })),
  ];
}

/** What the pane showed for each target: sent back so the route can tell if it moved since. */
export function draftBasis(plan, ops) {
  const lifts = {};
  const mains = {};
  for (const op of ops) {
    if (op.kind === "mainLift") {
      const m = plan.mains.find((x) => x.canonical === op.canonical);
      if (m) mains[op.canonical] = m.basis;
    } else {
      const l = plan.lifts.find((x) => x.name === op.lift);
      if (l) lifts[op.lift] = l.basis;
    }
  }
  return { lifts, mains, week: {} };
}

const EMPTY_DRAFTS = Object.freeze({ w: {}, r: {}, m: {} });
const draftCount = (d) => Object.keys(d.w).length + Object.keys(d.r).length + Object.keys(d.m).length;

/** @type {import("react").CSSProperties} */
const sheetStyle = {
  padding: "26px 24px calc(24px + env(safe-area-inset-bottom))", width: "100%", boxSizing: "border-box",
  animation: `slideUp 260ms ${T.ease}`, maxHeight: "90vh", overflowY: "auto", outline: "none",
};
/** @type {import("react").CSSProperties} */
const commitStyle = {
  width: "100%", height: 52, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong,
};
/** Full-width, outlined: every sheet action but Send. @type {import("react").CSSProperties} */
const outlineStyle = {
  width: "100%", height: 52, background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink,
};
/** @type {import("react").CSSProperties} */
const textBtn = {
  width: "100%", padding: "12px", marginTop: 4, background: "none", border: "none", cursor: "pointer",
  fontSize: 13, color: T.ink3, fontFamily: T.text,
};
/** @type {import("react").CSSProperties} */
const smallBtn = {
  background: "none", border: `1px solid ${T.rule}`, borderRadius: T.rSm, cursor: "pointer",
  fontFamily: T.text, fontSize: 13, color: T.ink2, minHeight: 36, padding: "0 12px", flexShrink: 0,
};
/** @type {import("react").CSSProperties} */
const subKicker = { fontSize: 12, color: T.ink3, margin: "16px 0 4px" };
/** @type {import("react").CSSProperties} */
const statusLine = { fontSize: 13, color: T.ink2, lineHeight: 1.5, minHeight: 0 };
/** A chip: a pace preset, a main-lift option. @param {boolean} on @returns {import("react").CSSProperties} */
const chip = (on) => ({
  minHeight: 36, padding: "0 12px", borderRadius: T.rSm, cursor: "pointer", fontFamily: T.text, fontSize: 13,
  border: `1px solid ${on ? T.ink : T.rule}`, background: on ? T.press : "none", color: on ? T.ink : T.ink2,
});

/**
 * The plan section and its sheets. Every request goes through onChange
 * (POST /api/trainer/change, the parent adds the grant and the date).
 * @param {{
 *   plan: any, name: string | null,
 *   onChange?: (body: any) => Promise<{ status: number, body: any }>,
 *   onFaceId?: () => Promise<boolean>,
 *   onChanged?: () => Promise<unknown> | unknown,
 * }} props
 */
function PlanSection({ plan, name, onChange, onFaceId, onChanged }) {
  const lifts = useMemo(() => (Array.isArray(plan?.lifts) ? plan.lifts : []), [plan]);
  const mains = useMemo(() => (Array.isArray(plan?.mains) ? plan.mains : []), [plan]);
  const changes = useMemo(() => (Array.isArray(plan?.changes) ? plan.changes : []), [plan]);
  const budget = plan?.budget || { used: 0, of: 10, freeAt: null };
  const outOfSends = budget.used >= budget.of;
  const mainFor = (liftName) => mains.find((m) => m.choice === liftName && Array.isArray(m.options) && m.options.length > 1) || null;

  const [drafts, setDrafts] = useState(EMPTY_DRAFTS);
  const [sheet, setSheet] = useState(/** @type {string | null} */ (null));
  const [reviewing, setReviewing] = useState(false);
  const [status, setStatus] = useState("");
  const count = draftCount(drafts);
  const ops = useMemo(() => draftOps(drafts), [drafts]);
  const sheetLift = sheet ? lifts.find((l) => l.name === sheet) || null : null;

  // The lift sheet's answer: a value equal to what's in the plan drops its draft.
  const saveLift = (lift, { kg, reps, choice }) => {
    const main = mainFor(lift.name);
    const next = { w: { ...drafts.w }, r: { ...drafts.r }, m: { ...drafts.m } };
    delete next.w[lift.name]; delete next.r[lift.name];
    if (main) delete next.m[main.canonical];
    if (main && choice && choice !== main.choice) {
      next.m[main.canonical] = choice;
    } else {
      if (kg != null && kg !== lift.w) next.w[lift.name] = kg;
      if (reps != null && reps !== repCount(lift.reps)) next.r[lift.name] = reps;
    }
    if (draftCount(next) > MAX_OPS) { setStatus(`Up to ${MAX_OPS} changes in one send. Send these first.`); return false; }
    setDrafts(next);
    const n = draftCount(next);
    setStatus(n ? `${n} change${n === 1 ? "" : "s"} to review` : "");
    return true;
  };

  const dropOps = (indices) => {
    const next = { w: { ...drafts.w }, r: { ...drafts.r }, m: { ...drafts.m } };
    for (const i of indices) {
      const op = /** @type {any} */ (ops[i]);
      if (!op) continue;
      if (op.kind === "weight") delete next.w[op.lift];
      else if (op.kind === "reps") delete next.r[op.lift];
      else if (op.kind === "mainLift") delete next.m[op.canonical];
    }
    setDrafts(next);
    setReviewing(false);
    setStatus(`Left out ${indices.length} change${indices.length === 1 ? "" : "s"}. Review again when ready.`);
  };

  const onSent = () => {
    setDrafts(EMPTY_DRAFTS);
    setReviewing(false);
    setStatus(`Sent to ${name || "them"}.`);
    onChanged?.();
  };

  // The line follows the reload: false from onChanged means it didn't load.
  const onRefresh = async () => {
    setReviewing(false);
    setStatus("Getting their latest.");
    const ok = await onChanged?.();
    setStatus(ok === false ? "Couldn't get their latest just now. Try again." : "Showing their latest.");
  };

  const bySession = useMemo(() => {
    /** @type {Map<string, any[]>} */
    const out = new Map();
    for (const l of lifts) {
      const k = l.session || "";
      out.set(k, [...(out.get(k) || []), l]);
    }
    return [...out];
  }, [lifts]);

  return (
    <div style={section} data-section="plan">
      <div style={kicker}>Plan</div>
      {plan?.deload?.active && (
        <p data-deload="" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "8px 0 0" }}>
          On a deload{plan.deload.until ? <> until about <Nums text={isoDayMonth(plan.deload.until)}/></> : null}. Weights can change once it ends.
        </p>
      )}
      {bySession.map(([letter, rows]) => (
        <div key={letter || "-"} data-plan-session={letter || undefined}>
          <div style={subKicker}>{letter ? `Session ${letter}` : "Other lifts"}</div>
          {rows.map((l) => (
            <PlanRow key={l.name} lift={l} main={mainFor(l.name)} drafts={drafts} onOpen={() => setSheet(l.name)}/>
          ))}
        </div>
      ))}

      <div data-tray="" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => { setStatus(""); setReviewing(true); }} disabled={count === 0 || outOfSends}
          className="forge-press forge-tint" style={{ ...quietBtn, color: count && !outOfSends ? T.ink : T.ink3, cursor: count && !outOfSends ? "pointer" : "default" }}>
          {count ? <Nums text={`${count} change${count === 1 ? "" : "s"} · Review`}/> : "No changes yet"}
        </button>
        {count > 0 && (
          <button type="button" onClick={() => { setDrafts(EMPTY_DRAFTS); setStatus("Cleared"); }} style={{ ...linkText }}>
            Clear
          </button>
        )}
      </div>
      <div role="status" aria-live="polite" style={{ ...statusLine, marginTop: 8 }}>{status}</div>

      <YourChanges changes={changes} lifts={lifts} name={name} budget={budget}
        onChange={onChange} onFaceId={onFaceId} onChanged={onChanged}/>

      {sheetLift && (
        <LiftSheet key={sheetLift.name} lift={sheetLift} main={mainFor(sheetLift.name)} drafts={drafts}
          onSave={(v) => { if (saveLift(sheetLift, v)) setSheet(null); }} onClose={() => setSheet(null)}/>
      )}
      {reviewing && count > 0 && (
        <ReviewSheet name={name} ops={ops} basis={draftBasis({ lifts, mains }, ops)} lifts={lifts} mains={mains} budget={budget}
          onChange={onChange} onFaceId={onFaceId} onSent={onSent} onDrop={dropOps}
          onRefresh={onRefresh}
          onClose={() => setReviewing(false)}/>
      )}
    </div>
  );
}

/** @type {import("react").CSSProperties} */
const linkText = { background: "none", border: "none", padding: "8px 0", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink2 };

function PlanRow({ lift, main, drafts, onOpen }) {
  const timed = isTimed(lift.name);
  const dw = Object.hasOwn(drafts.w, lift.name) ? drafts.w[lift.name] : null;
  const dr = Object.hasOwn(drafts.r, lift.name) ? drafts.r[lift.name] : null;
  const dm = main && Object.hasOwn(drafts.m, main.canonical) ? drafts.m[main.canonical] : null;
  const draft = dm ? `new main lift ${dm}, not sent`
    : dw != null || dr != null ? `new ${dw != null ? `${dw}${dr != null ? repsAfterKg(dr, timed) : ""}` : repsWords(dr, timed)}, not sent`
    : null;
  return (
    <button type="button" onClick={onOpen} className="forge-press forge-tint" data-plan-lift={lift.name}
      style={{ display: "block", width: "100%", padding: "10px 0", background: "none", border: "none", borderTop: `1px solid ${T.ruleFaint}`, cursor: "pointer", textAlign: "left", fontFamily: T.text, color: T.ink }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 15, overflowWrap: "anywhere" }}>{lift.name}</span>
        {main && <span style={{ fontSize: 12, color: T.ink3, flexShrink: 0 }}>Main lift</span>}
      </span>
      <span style={{ display: "block", fontSize: 13, color: T.ink2, lineHeight: 1.5, marginTop: 2 }}>
        <Nums text={liftLine(lift)}/>
        {draft && <span style={{ color: T.ink }}> · <Nums text={draft}/></span>}
      </span>
    </button>
  );
}

/** − value + over a fixed range. */
function Stepper({ label, unit, children, onDown, onUp, canDown, canUp, disabled = false }) {
  const btn = (on) => ({
    width: 44, height: 44, borderRadius: T.r, border: `1px solid ${T.rule}`, background: "none",
    cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.4, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  });
  return (
    <div role="group" aria-label={label} style={{ display: "flex", alignItems: "center", gap: 12, opacity: disabled ? 0.5 : 1 }}>
      <button type="button" aria-label={`Less ${label.toLowerCase()}`} onClick={onDown} disabled={disabled || !canDown} style={btn(!disabled && canDown)}>
        <Glyph name="minus" size={14} color={T.ink2}/>
      </button>
      <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontFamily: T.measured, fontSize: 26, color: T.ink }}>
        {children}<span style={{ fontFamily: T.text, fontSize: 13, color: T.ink3 }}> {unit}</span>
      </div>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={onUp} disabled={disabled || !canUp} style={btn(!disabled && canUp)}>
        <Glyph name="plus" size={14} color={T.ink2}/>
      </button>
    </div>
  );
}

/**
 * One lift: pace presets, a weight stepper over the implement's rungs inside
 * the bounds the validator gives, a reps (or seconds) stepper, and, on a
 * main lift, its options.
 */
function LiftSheet({ lift, main, drafts, onSave, onClose }) {
  const { containerRef, onKeyDown } = useInlineModalA11y(true, onClose);
  const timed = isTimed(lift.name);
  const lt = lift.loadType;
  const b = lift.bounds;
  const blocked = lift.blocked;
  const anchorKg = lift.anchor?.kg ?? null;
  const minKg = b ? b.min : 0;
  const maxKg = b ? (b.max ?? MAX_KG) : 0;
  const clampKg = (v) => Math.min(maxKg, Math.max(minKg, v));

  // Not lifted and no next weight: the field starts empty, not at one step.
  const startKg = Object.hasOwn(drafts.w, lift.name) ? drafts.w[lift.name] : (lift.w ?? anchorKg ?? null);
  const [kg, setKg] = useState(/** @type {number | null} */ (startKg));
  const [kgText, setKgText] = useState(startKg == null ? "" : String(startKg));
  // Only a weight or reps the trainer touched (or drafted before) becomes a change.
  const [kgTouched, setKgTouched] = useState(Object.hasOwn(drafts.w, lift.name));
  const setBoth = (v) => { setKg(v); setKgText(String(v)); setKgTouched(true); };
  const commitText = () => {
    const v = parseFloat(kgText.replace(",", "."));
    if (Number.isFinite(v) && v > 0) setBoth(clampKg(snapToImplement(v, lt)));
    else setKgText(kg == null ? "" : String(kg));
  };
  const down = kg == null ? null : nextRung(kg, lt, -1);
  const up = kg == null ? minKg : nextRung(kg, lt, +1);

  const repRange = timed ? TIMED_SECONDS : { ...REP_LIMITS, step: 1 };
  // A plan value outside the drum's range starts at its nearest end, so every step lands inside it.
  const rawReps = Object.hasOwn(drafts.r, lift.name) ? drafts.r[lift.name] : (repCount(lift.reps) ?? repRange.min);
  const startReps = Math.min(repRange.max, Math.max(repRange.min, rawReps));
  const [reps, setRepsRaw] = useState(startReps);
  const [repsTouched, setRepsTouched] = useState(Object.hasOwn(drafts.r, lift.name));
  const setReps = (f) => { setRepsRaw(f); setRepsTouched(true); };
  // Steps land on the grid (fives for seconds), from wherever the plan sits.
  const repsDown = Math.max(repRange.min, Math.ceil(reps / repRange.step) * repRange.step - repRange.step);
  const repsUp = Math.min(repRange.max, Math.floor(reps / repRange.step) * repRange.step + repRange.step);

  const [choice, setChoice] = useState(main ? (drafts.m[main.canonical] ?? main.choice) : null);
  const switching = !!main && choice !== main.choice;
  const weighable = !!b && !blocked;

  // Pace presets (§5): the last top set, the engine's next, the top of the
  // range, and the engine's 5% drop.
  const presets = [];
  if (weighable && anchorKg != null) {
    presets.push(["Hold", clampKg(anchorKg)]);
    if (lift.w != null) presets.push(["Step", clampKg(lift.w)]);
    if (b.max != null) presets.push(["Jump", b.max]);
    presets.push(["Ease", clampKg(snapToImplement(anchorKg * 0.95, lt))]);
  }
  // One caption for the two presets whose names don't say what they are.
  const presetNote = [
    presets.some(([l]) => l === "Step") && "Step is their app's next weight.",
    presets.some(([l]) => l === "Jump") && "Jump is the most this change allows.",
  ].filter(Boolean).join(" ");

  const weightLabel = lt === "assisted_bodyweight" ? "Assistance" : isBodyweightMovement(lt) ? "Added weight" : lt === "per_db" ? "Weight, each dumbbell" : "Weight";
  const blockedText = !blocked ? null
    : blocked.code === "deload" ? (blocked.until ? `After their deload ends, about ${isoDayMonth(blocked.until)}` : "After their deload ends")
    : blocked.code === "recovery" ? `After their next ${lift.name} session`
    : blocked.code === "range" ? `Their last top set is over ${MAX_KG} kg, the most their app takes. Change their reps instead.`
    : noHistoryText(0);
  const noWeight = timed ? "A timed hold, so seconds only." : lt === "bodyweight" ? "Bodyweight, so reps only." : "Reps only for this one.";
  const range = !b ? null
    : anchorKg != null ? `Up to ${b.max} kg: last top set ${anchorKg} kg`
    : noHistoryText(b.max);

  const save = () => onSave({
    kg: weighable && !switching && kgTouched ? kg : null,
    reps: !switching && repsTouched ? reps : null,
    choice,
  });

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="trainer-lift-title" tabIndex={-1}
        onClick={(e) => e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={sheetStyle}>
        <div id="trainer-lift-title" style={{ fontSize: 18, fontWeight: 500, color: T.ink, lineHeight: 1.3, marginBottom: 4 }}>{lift.name}</div>
        <div style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, marginBottom: 18 }}><Nums text={liftLine(lift)}/></div>

        {main && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>Main lift</div>
            <div role="radiogroup" aria-label="Main lift" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {main.options.map((o) => (
                <button key={o} type="button" role="radio" aria-checked={choice === o} onClick={() => setChoice(o)} style={chip(choice === o)}>{o}</button>
              ))}
            </div>
            {switching && (
              <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "10px 0 0" }}>
                {choice} takes this slot from their next session. Their app sets its weight as it does for any new lift.
              </p>
            )}
          </div>
        )}

        {!switching && (
          <>
            {b && (
              <div data-weight="" style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>{weightLabel}</div>
                {blocked ? (
                  <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.5, margin: 0 }}><Nums text={blockedText}/></p>
                ) : (
                  <>
                    {presets.length > 0 && (
                      <div role="group" aria-label="Pace" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                        {presets.map(([label, v]) => (
                          <button key={label} type="button" aria-pressed={kg === v} onClick={() => setBoth(v)} style={chip(kg === v)}>
                            {label} <span style={{ fontFamily: T.measured }}>{v}</span><span> kg</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <Stepper label={weightLabel} unit="kg" canDown={down != null && down >= minKg} canUp={up <= maxKg}
                      onDown={() => { if (down != null) setBoth(clampKg(down)); }} onUp={() => setBoth(clampKg(up))}>
                      <input aria-label={`${weightLabel} in kg`} inputMode="decimal" value={kgText}
                        onChange={(e) => setKgText(e.target.value)} onBlur={commitText}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        style={{ width: `${Math.max(5, kgText.length + 1)}ch`, maxWidth: "100%", textAlign: "center", fontFamily: T.measured, fontSize: 26, color: T.ink, background: "transparent", border: "none", borderBottom: `1px solid ${T.rule}`, padding: 0 }}/>
                    </Stepper>
                    <div style={{ fontSize: 12, color: T.ink3, lineHeight: 1.5, marginTop: 8 }}>
                      <div><Nums text={range}/></div>
                      <div><Nums text={`Not below ${minKg} kg`}/></div>
                      {presetNote && <div>{presetNote}</div>}
                    </div>
                    {b.warnBelow != null && kg != null && kg < b.warnBelow && (
                      <div style={{ fontSize: 13, color: T.under, marginTop: 6 }}>{warningText("big_drop")}</div>
                    )}
                  </>
                )}
              </div>
            )}
            {!b && <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: "0 0 12px" }}>{noWeight}</p>}
            <div data-reps="" style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>{timed ? "Seconds" : perLeg(lift.reps) ? "Reps, each leg" : "Reps"}</div>
              <Stepper label={timed ? "Seconds" : "Reps"} unit={timed ? "s" : "reps"}
                canDown={repsDown < reps} canUp={repsUp > reps}
                onDown={() => setReps(repsDown)} onUp={() => setReps(repsUp)}>
                <span>{reps}</span>
              </Stepper>
            </div>
          </>
        )}

        <button type="button" onClick={save} className="forge-press forge-tint" style={outlineStyle}>Add to changes</button>
        <button type="button" onClick={onClose} style={textBtn}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The review: a dry run of the drafted set, before → after with its
 * warnings, then the send. The set id is minted when the sheet opens; the
 * send carries the same id and ops the dry run passed.
 */
function ReviewSheet({ name, ops, basis, lifts, mains, budget, onChange, onFaceId, onSent, onDrop, onRefresh, onClose }) {
  const [setId, setSetId] = useState(mintSetId);
  // checking · ready · refused · stale · face · editsOff · budget · gone · error · sending
  const [phase, setPhase] = useState("checking");
  const [preview, setPreview] = useState(/** @type {any} */ (null));
  const [refusals, setRefusals] = useState(/** @type {any[]} */ ([]));
  const [note, setNote] = useState("");
  const [freeAt, setFreeAt] = useState(/** @type {number | null} */ (null));
  const [retry, setRetry] = useState(/** @type {"check" | "send"} */ ("check"));
  const inFlight = useRef(false);
  const busy = phase === "checking" || phase === "sending";
  const close = () => { if (!busy) onClose(); };
  const { containerRef, onKeyDown } = useInlineModalA11y(true, close);
  const timedOf = (target) => !!lifts.find((l) => l.name === target) && isTimed(target);

  /** The reply to a dry run or a send, as the sheet's phase. */
  const settle = (r, step) => {
    const body = r.body || {};
    if (r.status === 200 && step === "check" && body.preview) { setPreview(body.preview); setPhase("ready"); return; }
    if (r.status === 200 && step === "send" && body.sent) { onSent(body); return; }
    if (r.status === 403 && body.needsFaceId) { setRetry(step); setPhase("face"); return; }
    if (r.status === 403 && body.editsOff) { setPhase("editsOff"); return; }
    if (r.status === 409 && body.stale) { setPhase("stale"); return; }
    if (r.status === 409 && body.taken) { setSetId(mintSetId()); setNote("That didn't send. Try again."); setPhase("ready"); return; }
    if (r.status === 422 && Array.isArray(body.refusals)) { setRefusals(body.refusals); setPhase("refused"); return; }
    if (r.status === 429 && body.budget) { setFreeAt(typeof body.budget.freeAt === "number" ? body.budget.freeAt : null); setPhase("budget"); return; }
    if (r.status === 404) { setPhase("gone"); return; }
    setNote(r.status === 0 ? "You're offline. Try again when you're back."
      : r.status === 429 ? "Too many tries. Wait a minute, then try again."
      : step === "send" ? "That didn't send. Try again." : "Couldn't check that just now. Try again.");
    setPhase(step === "send" && preview ? "ready" : "error");
  };

  const run = async (step, id = setId) => {
    if (inFlight.current || !onChange) return;
    inFlight.current = true;
    const body = { set: { id, ops }, basis, ...(step === "check" ? { dryRun: true } : {}) };
    const r = await onChange(body).catch(() => ({ status: 0, body: {} }));
    inFlight.current = false;
    settle(r, step);
  };
  const check = () => { setNote(""); setPhase("checking"); run("check"); };
  const send = () => { if (phase !== "ready") return; setNote(""); setPhase("sending"); run("send"); };
  const confirmIt = async () => {
    setNote("");
    const ok = await onFaceId?.();
    if (!ok) { setNote("Face ID didn't go through. Try again."); return; }
    if (retry === "send") { setPhase("sending"); run("send"); } else check();
  };

  // The dry run starts when the sheet opens.
  const onOpen = useEffectEvent(() => { run("check"); });
  useEffect(() => { onOpen(); }, []);

  const refusedAt = new Map(refusals.filter((x) => Number.isInteger(x.i)).map((x) => [x.i, x]));
  const setLevel = refusals.some((x) => !Number.isInteger(x.i));
  // Until the dry run answers, the lines come from the pane's own numbers.
  const local = ops.map((op, i) => {
    if (op.kind === "mainLift") {
      const m = mains.find((x) => x.canonical === op.canonical);
      return { i, kind: op.kind, target: op.canonical, before: m?.choice ?? op.canonical, after: op.choice, warnings: [] };
    }
    const lift = lifts.find((l) => l.name === op.lift);
    const before = op.kind === "weight" ? lift?.w ?? null : lift?.reps ?? null;
    return { i, kind: op.kind, target: op.lift, before, after: op.kind === "weight" ? op.kg : op.reps, warnings: [] };
  });
  const rows = phase === "ready" || phase === "sending" ? (preview?.ops || []) : local;
  /** @type {Record<string, string>} */
  const PHASE_TEXT = {
    checking: "Checking against their limits",
    sending: "Sending",
    refused: setLevel ? "That set couldn't be checked. Keep editing and try again." : "Some of these are outside their limits.",
    stale: "They've trained or changed it since you looked. Refresh to see their latest.",
    face: `Confirm it's you to ${retry === "send" ? "send" : "check"} changes.`,
    editsOff: `Changes are off for ${name || "them"} now. Ask them to turn changes on in Profile.`,
    budget: `That's this week's changes for ${name || "them"}.${freeAt ? ` More from ${msDayLabel(freeAt)}.` : ""}`,
    gone: "Not shared with you now.",
  };
  const phaseText = PHASE_TEXT[phase] ?? "";

  return (
    <div onKeyDown={onKeyDown} onClick={close} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="trainer-review-title" tabIndex={-1}
        onClick={(e) => e.stopPropagation()} className="forge-sheet-ground forge-vellum" style={sheetStyle}>
        <div id="trainer-review-title" style={{ fontSize: 18, fontWeight: 500, color: T.ink, lineHeight: 1.3, marginBottom: 14 }}>
          {name ? `Change ${name}'s plan?` : "Change their plan?"}
        </div>
        <ul aria-label="Changes" style={{ listStyle: "none", margin: "0 0 14px", padding: 0 }}>
          {rows.map((op, k) => {
            const i = op.i ?? k;
            const refused = phase === "refused" ? refusedAt.get(i) : null;
            const lift = lifts.find((l) => l.name === op.target);
            return (
              <li key={`${op.kind}:${op.target}`} data-op={i} style={{ padding: "8px 0", borderTop: `1px solid ${T.ruleFaint}` }}>
                <div style={{ fontSize: 14, color: T.ink }}><Nums text={previewLine(op, timedOf(op.target))}/></div>
                {(op.warnings || []).map((w) => warningText(w)).filter(Boolean).map((t) => (
                  <div key={t} style={{ fontSize: 13, color: T.under, marginTop: 2 }}>{t}</div>
                ))}
                {refused && (
                  <div data-refused="" style={{ fontSize: 13, color: T.ink2, marginTop: 2 }}>
                    <Nums text={refusalText(refused.code, { lift: op.target, until: refused.until ?? null, bounds: lift?.bounds ?? null })}/>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.55, margin: "0 0 6px" }}>They'll see each change and can undo it.</p>
        <p style={{ fontSize: 12, color: T.ink3, margin: "0 0 18px" }}><Nums text={`${budget.used} of ${budget.of} changes this week`}/></p>

        <div role="status" aria-live="polite" style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, marginBottom: 12, minHeight: 0 }}>
          {note && (phase === "ready" || phase === "error" || phase === "face") ? note : phase === "budget" ? <Nums text={phaseText}/> : phaseText}
        </div>

        {phase === "face" && <button type="button" onClick={confirmIt} style={commitStyle}>Confirm it's you</button>}
        {phase === "stale" && <button type="button" onClick={onRefresh} className="forge-press forge-tint" style={outlineStyle}>Refresh</button>}
        {phase === "refused" && !setLevel && (
          <button type="button" onClick={() => onDrop([...refusedAt.keys()])} className="forge-press forge-tint" style={outlineStyle}>Leave those out</button>
        )}
        {phase === "error" && <button type="button" onClick={check} className="forge-press forge-tint" style={outlineStyle}>Check again</button>}
        {(phase === "ready" || phase === "sending" || phase === "checking") && (
          <button type="button" onClick={send} aria-disabled={phase !== "ready"} data-send=""
            style={{ ...commitStyle, opacity: phase === "ready" ? 1 : 0.6, cursor: phase === "ready" ? "pointer" : "default" }}>
            {phase === "sending" ? "One moment" : name ? `Send to ${name}` : "Send"}
          </button>
        )}
        <button type="button" onClick={close} style={textBtn}>Keep editing</button>
      </div>
    </div>
  );
}

/**
 * The trainer's own changes, grouped by set, newest first, with their
 * status and Withdraw where a change can still be taken back.
 */
function YourChanges({ changes, lifts, name, budget, onChange, onFaceId, onChanged }) {
  const [shown, setShown] = useState(SETS_PAGE);
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  // A withdraw waiting on Face ID: what it takes back, and whether any of it is in force.
  const [face, setFace] = useState(/** @type {{ x: string, inForce: boolean } | null} */ (null));
  const [msg, setMsg] = useState("");

  const sets = useMemo(() => {
    /** @type {Map<string, any[]>} */
    const by = new Map();
    for (const c of changes) {
      const k = c.set || c.id;
      by.set(k, [...(by.get(k) || []), c]);
    }
    return [...by].map(([id, rows]) => ({ id, rows, at: Math.max(...rows.map((r) => r.at || 0)) })).sort((a, b) => b.at - a.at);
  }, [changes]);

  // The latest reps change per lift: rep adoption may have moved them since.
  const settled = (c) => {
    if (c.kind !== "reps" || c.status !== "trained_yours") return null;
    const latest = changes.filter((x) => x.kind === "reps" && x.target === c.target).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    if (latest?.id !== c.id) return null;
    const now = lifts.find((l) => l.name === c.target)?.reps;
    return now != null && repCount(now) !== repCount(c.after) ? repCount(now) : null;
  };

  const withdraw = async (x, wasInForce) => {
    if (busy || !onChange) return;
    setBusy(x); setMsg(""); setFace(null);
    const r = await onChange({ withdraw: x }).catch(() => ({ status: 0, body: {} }));
    setBusy(null);
    if (r.status === 200 && Array.isArray(r.body?.withdrawn) && r.body.withdrawn.length === 0) {
      // Nothing matched: it was undone already, or has moved past taking back.
      setMsg("Nothing to withdraw. It's already undone, or it can't be taken back now.");
      onChanged?.();
    } else if (r.status === 200) {
      setMsg(wasInForce ? `Withdrawn. ${name ? `${name}'s` : "Their"} app puts it back next time it opens.` : `Withdrawn. It won't reach ${name || "them"}.`);
      onChanged?.();
    } else if (r.status === 403 && r.body?.needsFaceId) {
      setFace({ x, inForce: wasInForce });
    } else if (r.status === 403 && r.body?.editsOff) {
      setMsg(`Changes are off for ${name || "them"} now. Anything not landed won't land.`);
    } else {
      setMsg(r.status === 0 ? "You're offline. Try again when you're back." : "Couldn't withdraw that just now. Try again.");
    }
  };
  const confirmIt = async () => {
    if (!face) return;
    const ok = await onFaceId?.();
    if (!ok) { setMsg("Face ID didn't go through. Try again."); return; }
    withdraw(face.x, face.inForce);
  };

  return (
    <div data-section="changes" style={{ marginTop: 24 }}>
      <div style={{ ...kicker, marginBottom: 4 }}>Your changes</div>
      <div style={{ fontSize: 12, color: T.ink3, marginBottom: 8 }}>
        <Nums text={`${budget.used} of ${budget.of} changes this week`}/>
        {budget.used >= budget.of && budget.freeAt ? <> · <Nums text={`more from ${msDayLabel(budget.freeAt)}`}/></> : null}
      </div>
      {sets.length === 0 && <div style={{ fontSize: 13, color: T.ink2 }}>Nothing sent yet.</div>}
      {sets.slice(0, shown).map((s) => {
        const open = s.rows.filter(withdrawable);
        const all = open.length > 1 && s.rows.filter(reachedBySet).every(withdrawable);
        return (
          <div key={s.id} data-set={s.id} style={{ borderTop: `1px solid ${T.ruleFaint}`, padding: "10px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ flex: 1, fontSize: 13, color: T.ink3 }}>{s.at ? <Nums text={`Sent ${msDayMonth(s.at)}`}/> : "Sent"}</div>
              {all && (
                <button type="button" onClick={() => withdraw(s.id, open.some((c) => c.status === "in_force"))} aria-disabled={!!busy} style={smallBtn}>Withdraw all</button>
              )}
            </div>
            {s.rows.map((c) => {
              const adopted = settled(c);
              return (
                <div key={c.id} data-change={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: T.ink, overflowWrap: "anywhere" }}><Nums text={changeLine(c)}/></div>
                    <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>
                      <Nums text={trainerStatusText(c, name)}/>
                      {adopted != null ? <> · <Nums text={`They've since settled on ${adopted}`}/></> : null}
                    </div>
                    {(c.warnings || []).map((w) => warningText(w)).filter(Boolean).map((t) => (
                      <div key={t} style={{ fontSize: 12, color: T.under, marginTop: 2 }}>{t}</div>
                    ))}
                  </div>
                  {withdrawable(c) && (
                    <button type="button" onClick={() => withdraw(c.id, c.status === "in_force")} aria-disabled={!!busy} style={smallBtn}>
                      {busy === c.id ? "One moment" : "Withdraw"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {sets.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + SETS_PAGE)} className="forge-press forge-tint" aria-label="Show earlier changes" style={{ ...quietBtn, width: "100%", marginTop: 8 }}>
          Show earlier
        </button>
      )}
      <div role="status" aria-live="polite" style={{ ...statusLine, marginTop: 8 }}>
        {face ? "Confirm it's you to withdraw a change." : msg}
      </div>
      {face && (
        <button type="button" onClick={confirmIt} className="forge-press forge-tint" style={{ ...quietBtn, marginTop: 8 }}>Confirm it's you</button>
      )}
    </div>
  );
}
