"use client";

// components/BodyweightEditModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Bottom-sheet for editing bodyweight — and, since Photos P2, the capture
// point for progress photos: the scale moment is the ideal, consistent
// context for a physique photo (same time, same conditions), which is what
// makes the Lab scrubber honest rather than noisy.
//
// HARD CONSTRAINT (boss, 2026-07-20): ONE sheet, no stacked cards — the
// chin/status-bar seam breaks under stacking (audit #72 territory). The flow
// MORPHS this sheet's content through steps instead:
//
//   weight → offer → [secure] → camera → done
//
// Rules:
//   - The weight SAVES on Confirm, before any photo step — the photo flow
//     never holds the measurement hostage.
//   - Photos are passkey territory (privacy contract, /api/photos): the
//     "secure" step runs passkey setup INLINE and continues the flow — the
//     feature recruits for security rather than hiding behind it.
//   - Support, never demand: "Not today" is always one tap, no nagging, and
//     declining leaves no residue.
//   - All user-facing strings sit in the COPY object below, flagged for the
//     boss's pass ("sexy pass" pending — these are functional drafts).
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { useModalA11y, haptic } from "@/lib/a11y";
import { T } from "@/lib/tokens";
import ScrollDrum from "@/components/ScrollDrum";
import { hasPasskey, registerPasskey, authenticatePasskey, isWebAuthnSupported } from "@/lib/webauthn";
import { preparePhoto, uploadPhoto } from "@/lib/photos";
import { todayLocalIso } from "@/lib/dates";

// COPY: functional drafts — boss pass pending on every string here.
const COPY = {
  offerTitle: "Capture today",
  offerBody: "You're at the scale anyway. A photo alongside the number keeps you honest with the mirror, not just the dial — your future self will want to see this.",
  offerYes: "Add a photo",
  offerNo: "Not today",
  secureTitle: "Let's make this secure first",
  secureBody: "Progress photos are yours alone. A passkey locks them to your face or fingerprint — one tap now, and every photo after this is protected.",
  secureCta: "Secure & continue",
  secureCancelled: "No pressure — your weight is saved. Photos will be here when you're ready.",
  cameraTitle: "Today's photo",
  cameraBody: "Same spot, same light does wonders for the timeline.",
  cameraPick: "Take photo",
  cameraConfirm: "Use this photo",
  cameraRetake: "Retake",
  doneTitle: "Logged.",
  doneBody: "Weight and photo, side by side. See the story build in the Lab.",
  errorPrepare: "That image didn't work — try another?",
  errorUpload: "Upload hiccup — your weight is saved; try the photo again from Profile.",
};

export default function BodyweightEditModal({ open, onClose, currentKg, onSave, profileName = null }) {
  const [kg, setKg] = useState(currentKg || 75);

  // Reset on open (render-phase adjustment — see prior revision's note).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKg(currentKg || 75);
  }

  if (!open) return null;

  const isFirstTime = currentKg === null || currentKg === undefined;
  return (
    <BodyweightEditModalInner
      key={String(open)}
      kg={kg} setKg={setKg} onClose={onClose} onSave={onSave}
      isFirstTime={isFirstTime} profileName={profileName}
    />
  );
}

function BodyweightEditModalInner({ kg, setKg, onClose, onSave, isFirstTime, profileName }) {
  const { containerRef, onKeyDown } = useModalA11y(onClose);
  const titleId = "bw-edit-title";

  // Step machine: weight → offer → secure → camera → done. Photo steps are
  // only reachable when a profile is known and WebAuthn exists; otherwise
  // Confirm closes exactly as it always did.
  const [step, setStep] = useState("weight");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [token, setToken] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const pickedFileRef = useRef(null);

  const photoCapable = !!profileName && isWebAuthnSupported();

  const confirmWeight = () => {
    onSave(kg);
    haptic.commit();
    if (photoCapable) setStep("offer");
    else onClose();
  };

  // offer → camera (token in hand) or secure (no passkey yet).
  const startPhoto = async () => {
    setBusy(true); setNote(null);
    try {
      const has = await hasPasskey(profileName);
      if (has === false) { setStep("secure"); return; }
      const auth = await authenticatePasskey(profileName);
      if (auth?.verified && auth?.authToken) { setToken(auth.authToken); setStep("camera"); }
      else setNote(COPY.secureCancelled);
    } catch {
      setNote(COPY.secureCancelled);
    } finally {
      setBusy(false);
    }
  };

  // secure: register inline, then authenticate to mint the photo token.
  const secureThenContinue = async () => {
    setBusy(true); setNote(null);
    try {
      const reg = await registerPasskey(profileName);
      if (!reg?.ok) { setNote(COPY.secureCancelled); return; }
      const auth = await authenticatePasskey(profileName);
      if (auth?.verified && auth?.authToken) { setToken(auth.authToken); setStep("camera"); }
      else setNote(COPY.secureCancelled);
    } catch {
      setNote(COPY.secureCancelled);
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    pickedFileRef.current = f;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    setNote(null);
  };

  const confirmPhoto = async () => {
    setBusy(true); setNote(null);
    try {
      const blob = await preparePhoto(pickedFileRef.current);
      if (!blob) { setNote(COPY.errorPrepare); return; }
      const res = await uploadPhoto(profileName, token, todayLocalIso(), blob, { bodyweightAt: kg });
      if (!res.ok) { setNote(COPY.errorUpload); return; }
      haptic.commit();
      setStep("done");
      setTimeout(onClose, 1400);
    } finally {
      setBusy(false);
    }
  };

  const sub = (text) => (
    <div style={{ fontSize: 12, color: T.text3, marginTop: 4, lineHeight: 1.5, maxWidth: 280 }}>{text}</div>
  );
  const cta = (label, onClick, { disabled = false } = {}) => (
    <button onClick={onClick} disabled={disabled || busy} style={{ width: "100%", padding: "16px", background: T.coral, border: "none", borderRadius: T.r.lg, cursor: busy ? "default" : "pointer", fontFamily: T.serif, fontSize: 18, fontWeight: 400, color: T.bg0, boxShadow: `0 8px 28px ${T.coral}26`, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: busy ? 0.6 : 1 }}>
      <span>{busy ? "One sec…" : label}</span>
      <span style={{ fontSize: 16 }}>→</span>
    </button>
  );
  const quiet = (label, onClick) => (
    <button onClick={onClick} disabled={busy} style={{ width: "100%", padding: "12px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: T.text3 }}>{label}</button>
  );
  // Picker triggers are <label htmlFor> — native association opens the hidden
  // file input with no ref access (react-hooks/refs stays quiet, and it's
  // less code than a click() forward anyway).
  const PICKER_ID = "bw-photo-input";
  const ctaLabel = (label) => (
    <label htmlFor={PICKER_ID} role="button" style={{ width: "100%", padding: "16px", background: T.coral, border: "none", borderRadius: T.r.lg, cursor: "pointer", fontFamily: T.serif, fontSize: 18, fontWeight: 400, color: T.bg0, boxShadow: `0 8px 28px ${T.coral}26`, display: "flex", alignItems: "center", justifyContent: "space-between", boxSizing: "border-box" }}>
      <span>{label}</span><span style={{ fontSize: 16 }}>→</span>
    </label>
  );
  const quietLabel = (label) => (
    <label htmlFor={PICKER_ID} role="button" style={{ display: "block", width: "100%", padding: "12px", textAlign: "center", cursor: "pointer", fontSize: 13, color: T.text3, boxSizing: "border-box" }}>{label}</label>
  );

  const titles = { weight: "Bodyweight", offer: COPY.offerTitle, secure: COPY.secureTitle, camera: COPY.cameraTitle, done: COPY.doneTitle };
  const subs = {
    weight: isFirstTime ? "Used for loaded pull-ups, dips, and other weighted bodyweight movements." : "Scroll to adjust",
    offer: COPY.offerBody, secure: COPY.secureBody, camera: COPY.cameraBody, done: COPY.doneBody,
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()} className="forge-sheet-ground" style={{ background: T.bg2, padding: "24px 24px calc(32px + env(safe-area-inset-bottom))", width: "100%", borderTop: `1px solid ${T.sage}28`, animation: `slideUp 260ms ${T.ease}`, outline: "none" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div id={titleId} style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 300, lineHeight: 1.1 }}>{titles[step]}</div>
            {sub(subs[step])}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: T.bg3, border: `1px solid ${T.bg4}`, borderRadius: T.r.sm, padding: "6px 10px", cursor: "pointer", color: T.text2, fontSize: 13, flexShrink: 0 }}>✕</button>
        </div>

        {note && (
          <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: T.r.md, background: `${T.gold}0E`, border: `1px solid ${T.gold}33`, fontSize: 12, color: T.text1, lineHeight: 1.5 }}>{note}</div>
        )}

        {step === "weight" && (<>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
            <ScrollDrum value={kg} onChange={setKg} step={0.5} min={40} max={200} unit="kg" />
          </div>
          {cta("Confirm", confirmWeight)}
        </>)}

        {step === "offer" && (<>
          {cta(COPY.offerYes, startPhoto)}
          {quiet(COPY.offerNo, onClose)}
        </>)}

        {step === "secure" && (<>
          {cta(COPY.secureCta, secureThenContinue)}
          {quiet(COPY.offerNo, onClose)}
        </>)}

        {step === "camera" && (<>
          <input id="bw-photo-input" type="file" accept="image/*" onChange={onFilePicked} style={{ display: "none" }} />
          {previewUrl ? (<>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Today's progress photo preview" style={{ maxWidth: "100%", maxHeight: "44vh", borderRadius: T.r.lg, objectFit: "contain" }} />
            </div>
            {cta(COPY.cameraConfirm, confirmPhoto)}
            {quietLabel(COPY.cameraRetake)}
          </>) : (<>
            {ctaLabel(COPY.cameraPick)}
            {quiet(COPY.offerNo, onClose)}
          </>)}
        </>)}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "8px 0 16px", fontSize: 40 }}>✓</div>
        )}
      </div>
    </div>
  );
}
