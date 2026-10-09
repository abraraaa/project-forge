"use client";

// components/ProfileView.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The /profile route wrapper around ProfileScreen (PR3 3d-route,
// storage-as-store). Reads everything from localStorage on mount (local is
// canonical) and calls the shared cores in lib/profile-actions:
//
//   activate → activateProfileCore, then router.push("/") — the app shell
//              remounts and hydrates the new profile from LS naturally. A
//              successful claim is a new person, so first run is STASHED the
//              same way (one-shot LS marker) for the shell to open.
//   focus    → saveFocusCore persists F + the re-rotated block; the summary
//              is STASHED (one-shot LS handoff) because the rotation-summary
//              modal lives on the home shell, which isn't mounted here —
//              ForgeApp takes + shows it on return.
//   cancel   → router.back() (push("/") fallback for deep links).
//
// Deliberately a plain full-page route, NOT an @overlay interception like
// /performance: activating a different profile MUST remount the shell so it
// can't keep rendering the previous profile's state underneath.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { P, BW, F, Bk, pushNow } from "@/lib/storage";
import { withNavTransition } from "@/lib/nav-transitions";
import { activateProfileCore, saveFocusCore, stashRotationSummary, stashFirstRun } from "@/lib/profile-actions";
import { DEFAULT_FOCUS } from "@/lib/programme";
import ProfileScreen from "@/components/ProfileScreen";
import FocusPickerSheet from "@/components/FocusPickerSheet";
import BreatherModal from "@/components/BreatherModal";
import ErrorBoundary from "@/components/ErrorBoundary";
import { fetchWithTimeout } from "@/lib/net";

/** The trainer share for the Profile row, or null (signed out, offline). */
async function fetchTrainerShare(profile) {
  try {
    const res = await fetchWithTimeout(`/api/sync/trainer?profile=${encodeURIComponent(profile)}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** What is new for the Profile sublines (the home dot's read), or null. */
async function fetchNoticeDots(profile) {
  try {
    const res = await fetchWithTimeout(`/api/sync/notices?profile=${encodeURIComponent(profile)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.dots === "object" ? body.dots : null;
  } catch { return null; }
}

export default function ProfileView() {
  const router = useRouter();
  // Lazy initialisers — localStorage reads are impure in render; function-form
  // useState runs once on mount, sidestepping the purity rule.
  const [current] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [existing] = useState(() => (typeof window === "undefined" ? [] : P.list()));
  const [mainLifts] = useState(() =>
    (typeof window === "undefined" ? {} : P.getMainLifts(P.getActive())));
  const [bodyweight, setBodyweight] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? null : BW.getKg(P.getActive()),
  );
  const [userFocus, setUserFocus] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? DEFAULT_FOCUS : F.get(P.getActive()),
  );
  const [bwEditOpen, setBwEditOpen] = useState(false);
  const [focusPickerOpen, setFocusPickerOpen] = useState(false);
  const [breatherOpen, setBreatherOpen] = useState(false);
  // The open breather (if any) — state so the row flips between "Need a
  // breather?" and "On a breather · Back to it" the instant one is
  // started or ended here, without a reload.
  const [activeBreather, setActiveBreather] = useState(() =>
    typeof window === "undefined" || !P.getActive() ? null : Bk.getActive(P.getActive()),
  );

  const handleStartBreather = useCallback((reason) => {
    if (!current) return;
    Bk.start(current, reason);
    setActiveBreather(Bk.getActive(current));
    setBreatherOpen(false);
    pushNow(current);
  }, [current]);

  // "Back to it" — manual resume. Ends the breather now (Bk.end), no
  // session required. The assurance affordance: undo a pause any time.
  const handleEndBreather = useCallback(() => {
    if (!current) return;
    Bk.end(current);
    setActiveBreather(null);
    pushNow(current);
  }, [current]);

  // "Your trainer": only what the server says; nothing is kept on the device.
  const [trainerShare, setTrainerShare] = useState(null);
  useEffect(() => {
    if (!current) return undefined;
    let off = false;
    fetchTrainerShare(current).then((share) => { if (!off) setTrainerShare(share); });
    return () => { off = true; };
  }, [current]);

  // Notices: once per visit, memory only. No answer means no words.
  const [noticeDots, setNoticeDots] = useState(null);
  useEffect(() => {
    if (!current) return undefined;
    let off = false;
    fetchNoticeDots(current).then((dots) => { if (!off) setNoticeDots(dots); });
    return () => { off = true; };
  }, [current]);

  // Settings surface needs an active profile — a deep link without one goes
  // to the gate at /.
  useEffect(() => {
    if (!current) router.replace("/");
  }, [current, router]);

  const onActivate = useCallback(async (name, opts = {}) => {
    const result = await activateProfileCore(name, opts);
    if (result.ok) {
      if (opts.claim) stashFirstRun(result.name);
      withNavTransition(() => router.push("/"), "nav-back");
    }
    return result;
  }, [router]);

  const onCancel = useCallback(() => {
    withNavTransition(() => {
      if (typeof window !== "undefined" && window.history.length > 1) router.back();
      else router.push("/");
    }, "nav-back");
  }, [router]);

  const updateBodyweight = useCallback((kg) => {
    if (!current) return;
    BW.set(current, kg);
    setBodyweight(kg);
    pushNow(current);
  }, [current]);

  const handleSaveFocus = useCallback((focus) => {
    if (!current) return;
    const { summary } = saveFocusCore(current, focus); // persists + pushes
    stashRotationSummary(current, summary);
    setUserFocus(focus);
    setFocusPickerOpen(false);
  }, [current]);

  if (!current) return null;

  return (
    <ErrorBoundary>
      <ProfileScreen
        existing={existing}
        current={current}
        onActivate={onActivate}
        onCancel={onCancel}
        bodyweight={bodyweight}
        bwEditOpen={bwEditOpen}
        setBwEditOpen={setBwEditOpen}
        updateBodyweight={updateBodyweight}
        userFocus={userFocus}
        onEditFocus={() => setFocusPickerOpen(true)}
        mainLifts={mainLifts}
        onOpenBreather={() => setBreatherOpen(true)}
        resting={!!activeBreather}
        restingReason={activeBreather?.reason || null}
        onEndBreather={handleEndBreather}
        trainerShare={trainerShare}
        noticeDots={noticeDots}
      />
      {focusPickerOpen && (
        <FocusPickerSheet current={userFocus} onSave={handleSaveFocus} onCancel={() => setFocusPickerOpen(false)} />
      )}
      {breatherOpen && (
        <BreatherModal onConfirm={handleStartBreather} onCancel={() => setBreatherOpen(false)} />
      )}
    </ErrorBoundary>
  );
}
