"use client";

// /diag-trainers: applications to coach, beside /diag-bugs in the admin
// corner; not wired into navigation. Reading needs an admin passkey
// ceremony, and each decision one from the last 5 minutes (the route checks
// both). What applicants wrote is strangers' text: shown as text only, the
// link never clickable. Decisions are status changes; nothing is deleted.

import { useRef, useState } from "react";
import { P } from "@/lib/storage";
import { getAuthTokenWithCeremony } from "@/lib/auth-session";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

// The route takes a ceremony up to 5 minutes old; reuse one inside 4.
const FRESH_FOR_MS = 4 * 60_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DIAG_TRAINERS_COPY = Object.freeze({
  kicker: "Admin",
  title: "Trainer applications",
  unlock: "Unlock with Face ID",
  none: "No one waiting.",
  waiting: (n) => `${n} waiting`,
  approve: "Approve",
  deny: "Not this time",
  decided: "Decided",
  closed: "Closed profile",
  faceId: "Face ID didn't go through. Try again.",
  adminOnly: "This page is for the admin.",
  gone: "Already decided. The list is up to date.",
  wrong: "Something went wrong. Try again.",
  status: Object.freeze({ approved: "Approved", denied: "Not this time", withdrawn: "Withdrawn" }),
});
const C = DIAG_TRAINERS_COPY;

/** "3 Oct". @param {number | null | undefined} ms */
function dayMonth(ms) {
  const d = new Date(ms ?? NaN);
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MON[d.getMonth()]}` : "";
}

/** "12 days on Heatwayve". @param {number | null | undefined} days */
function ageText(days) {
  if (days == null) return null;
  if (days < 1) return "new today";
  return days === 1 ? "1 day on Heatwayve" : `${days} days on Heatwayve`;
}

// Read in handlers only, never while rendering.
const clock = () => Date.now();
/** @param {{ at: number } | null} c */
const isFresh = (c) => !!c && clock() - c.at < FRESH_FOR_MS;

/** The page's own words for a status code; server text is never shown. @param {number} status */
const failText = (status) => (status === 401 ? C.faceId : status === 403 ? C.adminOnly : C.wrong);

/** @type {import("react").CSSProperties} */
const commitBtn = {
  flex: 1, height: 44, background: T.commit, border: "none", borderRadius: T.r, cursor: "pointer",
  fontFamily: T.text, fontSize: 15, fontWeight: 500, color: T.commitInk, boxShadow: T.elevStrong,
};
/** @type {import("react").CSSProperties} */
const quietBtn = {
  flex: 1, height: 44, padding: "0 16px", background: "none", border: `1px solid ${T.rule}`, borderRadius: T.r,
  cursor: "pointer", fontFamily: T.text, fontSize: 15, color: T.ink2,
};

export default function DiagTrainers() {
  const [profile] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [token, setToken] = useState(null);
  const fresh = useRef(/** @type {{ token: string, at: number } | null} */ (null));
  const [list, setList] = useState(/** @type {{ open: any[], decided: any[] } | null} */ (null));
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));

  /** @param {string} t */
  const fetchList = async (t) => {
    const res = await fetchWithTimeout("/api/diag/trainers", { headers: { "X-HW-Auth": t } });
    if (!res.ok) { setNote(failText(res.status)); return false; }
    const body = await res.json();
    setList({ open: Array.isArray(body?.open) ? body.open : [], decided: Array.isArray(body?.decided) ? body.decided : [] });
    return true;
  };

  const load = async () => {
    setBusy("load"); setNote(null);
    try {
      const t = token || await getAuthTokenWithCeremony(profile);
      if (!t) { setNote(C.faceId); return; }
      if (await fetchList(t)) setToken(t);
    } catch {
      setNote(C.wrong);
    } finally { setBusy(null); }
  };

  /** @param {string} accountId @param {"approve" | "deny"} decision */
  const decide = async (accountId, decision) => {
    setBusy(accountId); setNote(null);
    try {
      // A decision needs a ceremony from the last few minutes.
      let t = isFresh(fresh.current) ? fresh.current.token : null;
      if (!t) {
        const auth = await authenticatePasskey(profile).catch(() => null);
        if (auth?.verified && auth.authToken) {
          fresh.current = { token: auth.authToken, at: clock() };
          t = auth.authToken;
        }
      }
      if (!t) { setNote(C.faceId); return; }
      const res = await fetchWithTimeout("/api/diag/trainers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HW-Auth": t },
        body: JSON.stringify({ decision, accountId }),
      });
      if (res.status === 404) { setNote(C.gone); await fetchList(token || t); return; }
      if (!res.ok) {
        if (res.status === 401) fresh.current = null;
        setNote(failText(res.status));
        return;
      }
      const status = decision === "approve" ? "approved" : "denied";
      setList((l) => {
        if (!l) return l;
        const row = l.open.find((r) => r.accountId === accountId);
        return {
          open: l.open.filter((r) => r.accountId !== accountId),
          decided: row ? [{ ...row, status, decidedAt: clock() }, ...l.decided] : l.decided,
        };
      });
    } catch {
      setNote(C.wrong);
    } finally { setBusy(null); }
  };

  const open = list?.open ?? [];
  const decided = list?.decided ?? [];

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "52px 20px 40px", fontFamily: T.text, color: T.ink, WebkitFontSmoothing: "antialiased" }}>
      <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>{C.kicker}</div>
      <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: "0 0 18px" }}>{C.title}</h1>

      {!list && (
        <button type="button" onClick={load} disabled={busy === "load"} className="forge-press forge-tint"
          style={{ ...quietBtn, flex: "none", width: "100%", color: T.ink }}>
          {busy === "load" ? "…" : C.unlock}
        </button>
      )}
      <div role="status" aria-live="polite" style={{ fontSize: 13, color: T.ink2, marginTop: 10, minHeight: 18, lineHeight: 1.5 }}>
        {note || ""}
      </div>

      {list && (
        <section aria-label="Waiting">
          <div style={{ fontSize: 13, color: T.ink3, padding: "6px 0 8px" }}>{open.length ? C.waiting(open.length) : C.none}</div>
          {open.map((r) => (
            <article key={r.accountId} data-application={r.accountId}
              style={{ borderTop: `1px solid ${T.rule}`, padding: "16px 2px 18px" }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: T.ink, overflowWrap: "anywhere" }}>{r.name || C.closed}</div>
              <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>
                {[`applied ${dayMonth(r.appliedAt)}`, ageText(r.accountAge)].filter(Boolean).join(" · ")}
              </div>
              {r.about && (
                <p style={{ fontSize: 14, color: T.ink, lineHeight: 1.55, margin: "10px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.about}</p>
              )}
              {r.link && (
                <div data-link style={{ fontSize: 13, color: T.ink2, marginTop: 8, overflowWrap: "anywhere", userSelect: "all", WebkitUserSelect: "all" }}>{r.link}</div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button type="button" onClick={() => decide(r.accountId, "approve")} disabled={!!busy}
                  className="forge-press forge-lift" style={commitBtn}>{C.approve}</button>
                <button type="button" onClick={() => decide(r.accountId, "deny")} disabled={!!busy}
                  className="forge-press forge-tint" style={quietBtn}>{C.deny}</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {list && decided.length > 0 && (
        <section aria-label={C.decided} style={{ marginTop: 28 }}>
          <div style={{ fontSize: 13, color: T.ink3, paddingBottom: 8 }}>{C.decided}</div>
          {decided.map((r) => (
            <div key={r.accountId} data-decided={r.status}
              style={{ display: "flex", alignItems: "center", gap: 10, borderTop: `1px solid ${T.rule}`, padding: "12px 2px" }}>
              <Glyph name={r.status === "approved" ? "check" : r.status === "denied" ? "cross" : "minus"} size={13} color={T.ink3} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, color: T.ink, overflowWrap: "anywhere" }}>{r.name || C.closed}</div>
                <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>
                  {[C.status[r.status] || r.status, dayMonth(r.decidedAt)].filter(Boolean).join(" ")}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
