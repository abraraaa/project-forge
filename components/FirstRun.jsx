"use client";

// components/FirstRun.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The first-run steps after a name is claimed on a device with no profiles:
// Passkey (when the device can) → Focus → Main lifts → Strength days →
// Bodyweight + Let's go. ForgeApp mounts this once the profile is active, so
// the steps outlive the gate's unmount (they used to live in ProfileScreen,
// which activation unmounted before they could show).
//
// Writes go only through the save props, and only for a real change: Keep
// writes nothing. Focus and main lifts save as they change; the week saves
// on its Keep (each toggle re-derives the whole week); bodyweight on Let's go
// (Skip writes nothing).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { T, DISPLAY } from "@/lib/tokens";
import { registerPasskey } from "@/lib/webauthn";
import { consentClaim } from "@/lib/consent";
import { MAIN_LIFT_GROUPS, DEFAULT_FOCUS, WEEK } from "@/lib/programme";
import { mondayIndex } from "@/lib/dates";
import { useTodayIso } from "@/lib/use-today-iso";
import { withNavTransition } from "@/lib/nav-transitions";
import { firstSessionDay } from "@/lib/first-run";
import { Fade } from "@/components/ui";
import Glyph from "@/components/Glyph";
import ConsentLine from "@/components/ConsentLine";
import BodyweightDrum from "@/components/BodyweightDrum";
import FocusStep from "@/components/first-run/FocusStep";
import MainLiftsStep from "@/components/first-run/MainLiftsStep";
import DaysStep from "@/components/first-run/DaysStep";

const SLOTS = Object.keys(MAIN_LIFT_GROUPS);

// Same column as the step components. No viewport height: the shell owns it.
/** @type {import("react").CSSProperties} */
const PAGE = {
  background: "transparent", maxWidth: 430, margin: "0 auto",
  fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased",
  padding: "72px 24px 48px", position: "relative", overflow: "hidden",
  display: "flex", flexDirection: "column",
};
/** @type {import("react").CSSProperties} */
const PRIMARY = {
  width: "100%", height: 58, padding: "0 22px",
  background: T.commit, border: "none", borderRadius: T.r,
  fontFamily: T.text, fontSize: 17, fontWeight: 500, color: T.commitInk,
  boxShadow: T.elevStrong,
  display: "flex", alignItems: "center", justifyContent: "space-between",
};
/** @type {import("react").CSSProperties} */
const QUIET = {
  width: "100%", padding: "14px 24px",
  background: "transparent", border: "none",
  fontFamily: T.text, fontSize: 14, fontWeight: 400, color: T.ink3,
};

/** @param {{type?: string}[]} a @param {{type?: string}[]} b */
const sameWeek = (a, b) => a.length === b.length && a.every((d, i) => d?.type === b[i]?.type);

/**
 * @param {{
 *   name: string,
 *   existing?: string[],
 *   webAuthnSupported?: boolean,
 *   bodyweight?: number | null,
 *   userFocus?: string,
 *   mainLifts?: Record<string, string>,
 *   userWeek?: {s?: string, label?: string, type: string}[],
 *   onSaveFocus: (focus: string) => void,
 *   onSaveMainLift: (slot: string, lift: string) => void,
 *   onSaveWeek: (week: {s?: string, label?: string, type: string}[]) => void,
 *   onSaveBodyweight: (kg: number) => void,
 *   onDone: () => void,
 *   todayIdx?: number,
 * }} props  todayIdx is for tests and screenshots; the app leaves it to the clock.
 */
export default function FirstRun({
  name, existing = [], webAuthnSupported = false, bodyweight = null,
  userFocus = DEFAULT_FOCUS, mainLifts = {}, userWeek = WEEK,
  onSaveFocus, onSaveMainLift, onSaveWeek, onSaveBodyweight, onDone, todayIdx,
}) {
  // Only a device's first profile runs this; anyone else goes straight home.
  const notFirst = existing.length > 0;
  useEffect(() => { if (notFirst) onDone(); }, [notFirst, onDone]);

  const [step, setStep] = useState(() => (webAuthnSupported ? "passkey" : "focus"));
  const go = (next) => withNavTransition(() => setStep(next), null);

  // Picks shown over the stored values until the parent re-renders with them.
  const [focusPick, setFocusPick] = useState(/** @type {string|null} */ (null));
  const [liftPicks, setLiftPicks] = useState(/** @type {Record<string,string>} */ ({}));
  const [weekPick, setWeekPick] = useState(/** @type {any[]|null} */ (null));
  const [bwPick, setBwPick] = useState(/** @type {number|null} */ (null));

  const focus = focusPick ?? userFocus;
  const lifts = Object.fromEntries(SLOTS.map((s) => [s, liftPicks[s] || mainLifts?.[s] || s]));
  const week = weekPick ?? userWeek;

  const todayIso = useTodayIso();
  const today = todayIdx ?? mondayIndex(todayIso) ?? 0;

  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState(/** @type {string|null} */ (null));

  if (notFirst) return null;

  // Passkey: quiet and optional, unchanged from the old post-claim step.
  // Accept registers with the consent claim; a cancel or failure stays here
  // with a soft line so they can retry or take Later.
  if (step === "passkey") {
    const handleAccept = async () => {
      if (!name || passkeyBusy) return;
      setPasskeyBusy(true);
      setPasskeyError(null);
      try {
        const result = await registerPasskey(name, null, { consent: consentClaim() });
        if (result?.ok) {
          go("focus");
        } else {
          setPasskeyError(result === null ? null : "Setup didn't complete. Try again or skip for now.");
        }
      } catch (e) {
        console.error("[forge:onboarding-passkey]", e);
        setPasskeyError(e?.message || "Couldn't set up. Try again or skip.");
      }
      setPasskeyBusy(false);
    };

    return (
      <div style={PAGE}>
        <Fade d={0}>
          <div style={{ fontSize: 13, color: T.ink3, marginBottom: 18 }}>
            Secure across devices
          </div>
          <div style={{ ...DISPLAY, fontSize: 38, color: T.ink, marginBottom: 16 }}>
            A passkey
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 12 }}>
            Add one? Without it, your data lives only on this device — clearing your browser would lose everything.
          </p>
          <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 32 }}>
            With one, your name is yours across phone, laptop, anywhere. Face ID, Touch ID, or your device PIN.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 12, minHeight: 80 }}>
            {passkeyError && (
              <div style={{ padding: "10px 14px", borderRadius: T.r, background: T.surface, boxShadow: T.elev, fontSize: 13, color: T.ink, maxWidth: 320, textAlign: "center", lineHeight: 1.5 }}>
                {passkeyError}
              </div>
            )}
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button type="button" onClick={handleAccept} disabled={passkeyBusy} aria-describedby="consent-onboarding" style={{
              ...PRIMARY, cursor: passkeyBusy ? "default" : "pointer", opacity: passkeyBusy ? 0.6 : 1,
            }}>
              <span>{passkeyBusy ? "Setting up…" : "Add passkey"}</span>
              {!passkeyBusy && <Glyph name="arrowRight" size={14}/>}
            </button>
            <ConsentLine id="consent-onboarding" style={{ marginTop: -2, marginBottom: 4 }} />
            <button type="button" onClick={() => go("focus")} disabled={passkeyBusy} style={{
              ...QUIET, cursor: passkeyBusy ? "default" : "pointer",
            }}>
              Later
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  if (step === "focus") {
    return (
      <FocusStep
        value={focus}
        onChange={(f) => {
          if (f === focus) return;
          setFocusPick(f);
          onSaveFocus(f);
        }}
        onNext={() => go("lifts")}
      />
    );
  }

  if (step === "lifts") {
    return (
      <MainLiftsStep
        mainLifts={lifts}
        onChange={(slot, lift) => {
          if (!SLOTS.includes(slot) || lift === lifts[slot]) return;
          setLiftPicks((prev) => ({ ...prev, [slot]: lift }));
          onSaveMainLift(slot, lift);
        }}
        onNext={() => go("days")}
      />
    );
  }

  if (step === "days") {
    return (
      <DaysStep
        week={week}
        todayIdx={today}
        onChange={setWeekPick}
        onNext={() => {
          if (weekPick && !sameWeek(weekPick, userWeek)) onSaveWeek(weekPick);
          go("bw");
        }}
      />
    );
  }

  // Bodyweight + Let's go. The drum shows what is stored, else 75. With
  // nothing stored, Let's go saves what the drum shows, 75 included: it is
  // the answer, and the starting weights and the stale-weight card read it.
  // A stored value is saved again only if the drum moved.
  const bwShown = bwPick ?? bodyweight ?? 75;
  const firstDay = firstSessionDay(week, today);
  const handleGo = () => {
    const kg = bodyweight == null ? bwShown : bwPick;
    if (kg != null && kg !== bodyweight) onSaveBodyweight(kg);
    onDone();
  };

  return (
    <div style={PAGE}>
      <Fade d={0}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 18 }}>
          One measurement
        </div>
        <div style={{ ...DISPLAY, fontSize: 38, color: T.ink, marginBottom: 16 }}>
          Bodyweight
        </div>
      </Fade>

      <Fade d={80}>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, marginBottom: 32 }}>
          Your first weights come from this. Skip it and we start from the programme&apos;s defaults.
        </p>
      </Fade>

      <Fade d={140}>
        <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
          <BodyweightDrum value={bwShown} onChange={setBwPick} />
        </div>
      </Fade>

      <Fade d={200}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {firstDay && (
            <p id="first-session-line" style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "16px 0 4px" }}>
              First session: Strength A, {firstDay}.
            </p>
          )}
          <button type="button" className="forge-press" onClick={handleGo}
            aria-describedby={firstDay ? "first-session-line" : undefined}
            style={{ ...PRIMARY, cursor: "pointer" }}>
            <span>Let&apos;s go</span>
            <Glyph name="arrowRight" size={14}/>
          </button>
          <button type="button" onClick={onDone} style={{ ...QUIET, cursor: "pointer" }}>
            Skip
          </button>
        </div>
      </Fade>
    </div>
  );
}
