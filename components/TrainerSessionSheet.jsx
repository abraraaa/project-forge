"use client";

// components/TrainerSessionSheet.jsx
// ─────────────────────────────────────────────────────────────────────────────
// A session the client's trainer ran with them, waiting on their phone: the
// Home card (TrainerSessionCard) and the sheet it opens. Pure presentation:
// every decision goes out through props (onKeep, onDiscard, onFelt, onClose);
// ForgeApp owns the stores, the auto-keep timer and the hold that stops a
// keep landing while this sheet is open.
//
// The words come from the record, never from either clock: "yesterday",
// "Tuesday 6 Oct" (lib/trainer-change.js sessionDayWords), so a trainer and a
// client on different dates never both read "today".
//
// A card is what trainerLocal.pendingSessions holds (lib/storage.js):
// planSessionSteps' card { id, record, drum, by, startMs, keepsAt } plus the
// row's own fields.
// keepsAt null: sharing stopped after it arrived, so nothing keeps it but
// the client. Felt edits are a map of feltKey(block, exercise, set) → rpe.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useId, useRef, useState } from "react";
import { T, DISPLAY, heatForRpe, heatMarkHeight } from "@/lib/tokens";
import { Card, Fade, MonoNums } from "@/components/ui";
import Glyph from "@/components/Glyph";
import { useModalA11y, haptic } from "@/lib/a11y";
import { sessionDayWords, RPE_TRACK } from "@/lib/trainer-change";
import { timedTargetFor } from "@/lib/programme";
import { usesOptionalChrome } from "@/lib/lift-translations";
import { addDaysIso, localDateStr } from "@/lib/dates";
import { feltKey } from "@/lib/storage";

/**
 * The cards to show, oldest first, from a trainerLocal value (TL.get): the
 * sessions the last pull left waiting (lib/storage.js keeps them with
 * keepsAt worked out), less any this device has decided since. Reads only.
 * @param {any} tl
 */
export function sessionCardsFrom(tl) {
  const list = Array.isArray(tl?.pendingSessions) ? tl.pendingSessions : [];
  const acked = new Set((Array.isArray(tl?.outbox?.acks) ? tl.outbox.acks : []).map((a) => a?.id));
  return list
    .filter((c) => c && typeof c.id === "string" && Array.isArray(c.record?.blocks)
      && !tl?.sessions?.[c.id]?.decided && !acked.has(c.id))
    .map((c) => ({ ...c, keepsAt: typeof c.keepsAt === "number" && Number.isFinite(c.keepsAt) ? c.keepsAt : null }))
    .sort((a, b) => (num(a.startMs) - num(b.startMs)) || String(a.record.date).localeCompare(String(b.record.date)));
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** "Strength A" from the record's letter. */
export function sessionName(record) {
  const letter = typeof record?.scheduledLetter === "string" && record.scheduledLetter
    ? record.scheduledLetter
    : (/^strength-([abc])$/.exec(String(record?.session ?? ""))?.[1] ?? "").toUpperCase();
  return letter ? `Strength ${letter}` : "a session";
}

/**
 * "Sam ran Strength A with you yesterday", in the record's own day words.
 * @param {{ record: any, by?: string | null }} card
 * @param {string} todayIso  the client's local today
 */
export function sessionTitle(card, todayIso) {
  const who = typeof card?.by === "string" && card.by.trim() ? card.by.trim() : "Your trainer";
  const day = sessionDayWords(card?.record?.date, todayIso);
  const when = !day ? "" : day === "today" || day === "yesterday" ? ` ${day}` : ` on ${day}`;
  return `${who} ran ${sessionName(card?.record)} with you${when}`;
}

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * When it keeps itself, in words: "16:40", or "02:10 tomorrow" when that is
 * another local day. Null when nothing keeps it (sharing stopped).
 * @param {number | null | undefined} keepsAt
 * @param {number} nowMs
 */
export function keepsAtWords(keepsAt, nowMs) {
  if (typeof keepsAt !== "number" || !Number.isFinite(keepsAt)) return null;
  const at = new Date(keepsAt);
  const time = TIME.format(at);
  const day = localDateStr(at);
  const today = localDateStr(new Date(nowMs));
  if (day === today) return time;
  if (day === addDaysIso(today, 1)) return `${time} tomorrow`;
  return `${time} on ${sessionDayWords(day, today)}`;
}

/**
 * The quiet auto-keep line under the title, card and sheet alike. Once due,
 * the keep waits for a pull that lands (ForgeApp), so it names the sync, not
 * a time already past.
 */
function keepLine(card, nowMs) {
  const at = typeof card?.keepsAt === "number" ? keepsAtWords(card.keepsAt, nowMs) : null;
  if (!at) return "Sharing has stopped, so it waits here until you decide.";
  if (card.keepsAt <= nowMs) return "Five hours have passed. It's kept the next time the app syncs, unless you say otherwise.";
  return `Kept at ${at} unless you say otherwise`;
}

const setsIn = (record) => (record?.blocks ?? []).reduce((n, b) => n + (b?.exercises ?? []).reduce((m, e) => m + (e?.sets?.length ?? 0), 0), 0);

/** "5 reps", "8 reps a leg", "45 s" for a timed hold. */
function repsWords(name, reps) {
  if (timedTargetFor(name) !== null && typeof reps === "number") return `${reps} s`;
  const perLeg = typeof reps === "string" ? /^(\d+)\/leg$/.exec(reps) : null;
  if (perLeg) return `${perLeg[1]} ${perLeg[1] === "1" ? "rep" : "reps"} a leg`;
  const n = Number(reps);
  return Number.isFinite(n) ? `${n} ${n === 1 ? "rep" : "reps"}` : String(reps ?? "");
}

/** The load as the set card reads it: "100 kg", "Bodyweight", "+10 kg". */
function loadWords(loadType, weight) {
  const kg = typeof weight === "number" && Number.isFinite(weight) ? weight : null;
  if (usesOptionalChrome(loadType)) return kg && kg > 0 ? `Bodyweight +${kg} kg` : "Bodyweight";
  if (loadType === "assisted_bodyweight") return kg && kg > 0 ? `${kg} kg assist` : "Bodyweight";
  return kg === null ? null : `${kg} kg`;
}

const quietBtn = {
  background: "none", border: "none", cursor: "pointer", fontFamily: T.text, fontSize: 13, color: T.ink3,
};

// ─── Home card ───────────────────────────────────────────────────────────────

/**
 * One waiting session on Home, oldest first; `more` counts the rest.
 * @param {{ card: any, more?: number, todayIso: string, nowMs?: number, onReview: (id: string) => void }} props
 */
export function TrainerSessionCard({ card, more = 0, todayIso, nowMs, onReview }) {
  const [mountMs] = useState(() => Date.now());
  const now = typeof nowMs === "number" ? Math.max(nowMs, mountMs) : mountMs;
  const titleId = useId();
  return (
    <Fade d={165}>
      <Card style={{ margin: "20px 24px 0", padding: "18px 20px" }}>
        <div data-trainer-session-card="" style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>From your trainer</div>
        <div id={titleId} style={{ fontSize: 17, fontWeight: 500, color: T.ink, lineHeight: 1.3, marginBottom: 8 }}>
          {sessionTitle(card, todayIso)}. Keep it?
        </div>
        <div style={{ fontSize: 13, color: T.ink2, lineHeight: 1.55, marginBottom: 16 }}>
          <MonoNums>{keepLine(card, now)}</MonoNums>
          {more > 0 && <> · <MonoNums>{`${more} more after this`}</MonoNums></>}
        </div>
        <button type="button" className="forge-press" aria-describedby={titleId} onClick={() => onReview(card.id)}
          style={{ width: "100%", height: 46, background: T.ground, border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 14, fontWeight: 500, color: T.ink, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          Review <Glyph name="arrowRight" size={12}/>
        </button>
      </Card>
    </Fade>
  );
}

// ─── Felt stepper ────────────────────────────────────────────────────────────

/** Half steps on the felt track (6 to 10), with the heat mark beside the number. */
function FeltStepper({ value, sent, label, onChange }) {
  const step = (d) => {
    const next = Math.min(RPE_TRACK.max, Math.max(RPE_TRACK.min, value + d * RPE_TRACK.step));
    if (next !== value) { haptic.toggle(); onChange(next); }
  };
  const btn = (d, glyph, words, off) => (
    <button type="button" aria-label={`${words}, ${label}`} disabled={off} onClick={() => step(d)}
      style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.rSm, cursor: off ? "default" : "pointer", opacity: off ? 0.35 : 1, color: T.ink2 }}>
      <Glyph name={glyph} size={11} color={T.ink2}/>
    </button>
  );
  return (
    <div role="group" aria-label={`Felt, ${label}`} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      {btn(-1, "minus", "Easier", value <= RPE_TRACK.min)}
      <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 6, minWidth: 64, justifyContent: "center" }}>
        <span aria-hidden="true" style={{ width: 4, height: heatMarkHeight(value), background: heatForRpe(value), borderRadius: T.rMark, marginBottom: 3 }}/>
        <span aria-live="polite" style={{ fontSize: 13, color: value === sent ? T.ink2 : T.ink }}>
          felt <span style={{ fontFamily: T.measured }}>{value}</span>
        </span>
      </span>
      {btn(1, "plus", "Harder", value >= RPE_TRACK.max)}
    </div>
  );
}

// ─── The sheet ───────────────────────────────────────────────────────────────

/**
 * @param {{
 *   card: any, todayIso: string, felt?: Record<string, number>,
 *   onFelt: (felt: Record<string, number>) => void,
 *   onKeep: () => void, onDiscard: () => void, onClose: () => void,
 * }} props
 */
export default function TrainerSessionSheet({ card, todayIso, felt = {}, onFelt, onKeep, onDiscard, onClose }) {
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  // The clock the keep line reads: re-read once keepsAt passes with the
  // sheet open, so the line says it keeps on close (nothing keeps it here).
  const [openMs, setOpenMs] = useState(() => Date.now());
  const keepsAt = typeof card.keepsAt === "number" ? card.keepsAt : null;
  useEffect(() => {
    if (keepsAt === null || keepsAt <= openMs) return undefined;
    const t = setTimeout(() => setOpenMs(Date.now()), keepsAt - openMs + 50);
    return () => clearTimeout(t);
  }, [keepsAt, openMs]);
  // Once due, closing keeps it, so the close no longer offers "Later".
  const due = keepsAt !== null && keepsAt <= openMs;
  const [confirming, setConfirming] = useState(false);
  // Focus follows the swap between the buttons and the confirm, so it never
  // drops out of the dialog (where Escape and the trap live).
  const notMineRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const discardRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) discardRef.current?.focus();
    else if (wasConfirming.current) notMineRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const titleId = "trainer-session-title";
  const record = card.record;
  const who = typeof card.by === "string" && card.by.trim() ? card.by.trim() : "Your trainer";
  const whose = typeof card.by === "string" && card.by.trim() ? `${who}'s` : "your trainer's";
  const sets = setsIn(record);
  const absolute = sessionDayWords(record.date, null);
  const minutes = typeof record.duration === "number" && record.duration > 0 ? Math.round(record.duration / 60) : null;

  const setFelt = (key, rpe) => onFelt({ ...felt, [key]: rpe });

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim"
      style={{ overscrollBehavior: "contain", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="forge-sheet-ground forge-vellum"
        style={{ padding: "22px 24px calc(28px + env(safe-area-inset-bottom))", width: "100%", animation: `slideUp 280ms ${T.ease}`, maxHeight: "90vh", display: "flex", flexDirection: "column", boxSizing: "border-box", outline: "none" }}>

        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 10 }}>From your trainer</div>
        <h2 id={titleId} style={{ ...DISPLAY, fontSize: 28, lineHeight: 1.08, color: T.ink, margin: 0 }}>
          {sessionTitle(card, todayIso)}
        </h2>
        <div style={{ fontSize: 13, color: T.ink3, marginTop: 8, lineHeight: 1.5 }}>
          <MonoNums>{[absolute, `${sets} ${sets === 1 ? "set" : "sets"}`, minutes ? `${minutes} min` : null].filter(Boolean).join(" · ")}</MonoNums>
        </div>
        <div style={{ fontSize: 13, color: T.ink2, marginTop: 4, lineHeight: 1.5 }}>
          <MonoNums>{keepLine(card, openMs)}</MonoNums>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", margin: "16px -8px 0 0", paddingRight: 8 }}>
          {record.blocks.map((block, bi) => (block?.exercises ?? []).map((ex, ei) => {
            const loads = (ex.sets ?? []).map((s) => loadWords(s?.loadType ?? ex.loadType, s?.weight));
            const oneLoad = loads.every((l) => l === loads[0]) ? loads[0] : undefined;
            return (
              <section key={`${bi}.${ei}`} aria-label={ex.name} style={{ padding: "12px 0", borderTop: `1px solid ${T.ruleFaint}` }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: T.ink }}>
                  {ex.name}{oneLoad ? <span style={{ fontWeight: 400, color: T.ink2 }}> · <MonoNums>{oneLoad}</MonoNums></span> : null}
                </div>
                {ex.swapped && <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>Swapped in on the day</div>}
                {(ex.sets ?? []).map((s, si) => {
                  const key = feltKey(bi, ei, si);
                  const sent = typeof s?.rpe === "number" ? s.rpe : null;
                  const value = typeof felt[key] === "number" ? felt[key] : sent;
                  const words = [repsWords(ex.name, s?.reps), oneLoad === undefined ? loads[si] : null].filter(Boolean).join(" · ");
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 44, marginTop: 4 }}>
                      <span style={{ fontSize: 13, color: T.ink2 }}>
                        <MonoNums>{words}</MonoNums>{s?.reach ? " · reach" : ""}
                      </span>
                      {value !== null && (
                        <FeltStepper value={value} sent={sent} label={`${ex.name} set ${si + 1}`} onChange={(v) => setFelt(key, v)}/>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          }))}
        </div>

        {!confirming ? (
          <div style={{ paddingTop: 14, borderTop: `1px solid ${T.rule}` }}>
            <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.5, margin: "0 0 14px" }}>
              Keep adds it to your training, like a session you logged. You can&apos;t undo it.
            </p>
            <button type="button" onClick={() => { haptic.commit(); onKeep(); }}
              style={{ width: "100%", height: 54, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 16, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong }}>
              Keep
            </button>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button type="button" ref={notMineRef} onClick={() => setConfirming(true)}
                style={{ flex: 1, height: 46, background: T.ground, border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 14, fontWeight: 500, color: T.ink2 }}>
                Not mine
              </button>
              <button type="button" onClick={onClose}
                style={{ ...quietBtn, flexShrink: 0, height: 46, padding: "0 16px", fontSize: 14 }}>
                {due ? "Close" : "Later"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ paddingTop: 14, borderTop: `1px solid ${T.rule}` }}>
            <p style={{ fontSize: 14, color: T.ink, lineHeight: 1.5, margin: "0 0 14px" }}>
              Discard {whose} session? {who} will see you didn&apos;t keep it.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" ref={discardRef} onClick={() => { haptic.tap(); onDiscard(); }}
                style={{ flex: 1, height: 48, background: T.ground, border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.ink }}>
                Discard
              </button>
              <button type="button" onClick={() => setConfirming(false)}
                style={{ flexShrink: 0, height: 48, padding: "0 18px", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r, cursor: "pointer", fontFamily: T.text, fontSize: 14, color: T.ink2 }}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
