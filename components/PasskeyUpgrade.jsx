"use client";

// components/PasskeyUpgrade.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The re-enrolment prompt for passkeys bound to the retiring domain.
//
// Two surfaces, deliberately different in weight:
//   · PasskeyUpgradeCard  — a standing notice on the profile page. Never
//     snoozes, never interrupts; it is there when you go looking.
//   · PasskeyUpgradeModal — only in the closing stretch, and it rests for a
//     few days after each dismissal. A wall on every launch teaches people to
//     tap past without reading, which is how a real warning gets missed.
//
// The upgrade costs TWO authenticator prompts and the copy says so up front:
// one to prove control of the profile (the server refuses to staple a passkey
// onto a protected profile without it — that is the credential-stuffing
// defence), then one to create the new key. A user who is not warned reads the
// second prompt as a bug.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T } from "@/lib/tokens";
import Glyph from "@/components/Glyph";
import { useInlineModalA11y } from "@/lib/a11y";
import { registerPasskey } from "@/lib/webauthn";
import { getAuthTokenWithCeremony } from "@/lib/auth-session";
import { snoozePrompt } from "@/lib/passkey-upgrade";

const HEADLINE = "A new passkey, when you have a moment";
const BODY =
  "We’re improving security. Your current passkey will become redundant — setting up a new one keeps you signed in on every device.";
const TWO_PROMPTS = "You’ll be asked twice: once to confirm it’s you, then once to create the new key.";

/** Shared action. Returns true when a native credential was minted. */
async function runUpgrade(profile) {
  // Proving control first is required by the server whenever the profile still
  // holds a usable passkey. getAuthTokenWithCeremony reuses a cached token when
  // one is live, so a user who just signed in often sees only one prompt.
  const token = await getAuthTokenWithCeremony(profile);
  const result = await registerPasskey(profile, token);
  return !!result?.ok;
}

function useUpgradeAction(profile, onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await runUpgrade(profile)) onDone?.();
      else setError("Cancelled — your old passkey still works for now.");
    } catch (e) {
      setError(e?.message || "That didn’t work. Try again in a moment.");
    }
    setBusy(false);
  };
  return { busy, error, run };
}

const btn = (busy) => ({
  padding: "10px 16px", background: T.commit, border: "none", borderRadius: T.r,
  fontSize: 13, fontWeight: 500, fontFamily: T.text, color: T.commitInk,
  boxShadow: T.elevStrong, cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.6 : 1, whiteSpace: "nowrap",
});

/** @param {{ profile: string, state: any, onDone: () => void }} props */
export function PasskeyUpgradeCard({ profile, state, onDone }) {
  const { busy, error, run } = useUpgradeAction(profile, onDone);
  if (!state?.needed) return null;
  const days = typeof state.daysLeft === "number" ? state.daysLeft : null;

  return (
    <div style={{ marginTop: 16, padding: "18px 20px", background: T.surface, boxShadow: T.elev, borderRadius: T.r }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: T.ink3, marginBottom: 6 }}>
            {days === null ? "Security" : days > 0 ? `Security · ${days} days` : "Security"}
          </div>
          <div style={{ fontSize: 16, fontWeight: 500, color: T.ink, lineHeight: 1.35, marginBottom: 6 }}>
            {HEADLINE}
          </div>
          <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5 }}>{BODY}</p>
          <p style={{ fontSize: 12, color: T.ink3, lineHeight: 1.5, marginTop: 8 }}>{TWO_PROMPTS}</p>
        </div>
        <button onClick={run} disabled={busy} style={btn(busy)}>
          {busy ? "…" : "Set up"}
        </button>
      </div>
      {error && <div style={{ marginTop: 12, fontSize: 12, color: T.heat[4] }}>{error}</div>}
    </div>
  );
}

/** @param {{ profile: string, state: any, onDone: () => void, onSnooze: () => void }} props */
export function PasskeyUpgradeModal({ profile, state, onDone, onSnooze }) {
  const dismiss = () => { snoozePrompt(profile); onSnooze?.(); };
  const { busy, error, run } = useUpgradeAction(profile, onDone);
  const { containerRef, onKeyDown } = useInlineModalA11y(true, dismiss);
  const days = typeof state?.daysLeft === "number" ? state.daysLeft : null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center",
        justifyContent: "center", padding: 24, background: "rgba(0,0,0,0.42)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div
        ref={containerRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-upgrade-title"
        style={{
          width: "100%", maxWidth: 380, background: T.surface, borderRadius: T.r,
          boxShadow: T.elevStrong, padding: "24px 22px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Glyph name="check" size={13} color={T.ink3} />
          <span style={{ fontSize: 13, color: T.ink3 }}>
            {days !== null && days > 0 ? `${days} days left` : "Security"}
          </span>
        </div>
        <div id="passkey-upgrade-title" style={{ fontSize: 19, fontWeight: 500, color: T.ink, lineHeight: 1.3 }}>
          {HEADLINE}
        </div>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.55, marginTop: 10 }}>{BODY}</p>
        <p style={{ fontSize: 12, color: T.ink3, lineHeight: 1.5, marginTop: 8 }}>{TWO_PROMPTS}</p>
        {error && <div style={{ marginTop: 12, fontSize: 12, color: T.heat[4] }}>{error}</div>}
        <button onClick={run} disabled={busy} style={{ ...btn(busy), width: "100%", marginTop: 18, padding: "13px 16px", fontSize: 15 }}>
          {busy ? "…" : "Set up a new passkey"}
        </button>
        <button
          onClick={dismiss}
          style={{
            width: "100%", marginTop: 8, padding: "11px 16px", background: "none",
            border: "none", fontSize: 13, color: T.ink3, fontFamily: T.text, cursor: "pointer",
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
