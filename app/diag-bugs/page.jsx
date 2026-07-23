"use client";

// /diag-bugs — the review half of the fill-or-kill flow (boss spec,
// 2026-07-24: "listed somewhere you can read, dedupe and clean, we decide
// if it's in scope, then fill or kill"). Lives in the admin corner next to
// /diag-sync; not wired into navigation. Reading and triage both require a
// live passkey ceremony (reports are third-party text — the open-reads
// doctrine does not extend here). Triage is STATUS-ONLY: no delete verb
// exists for this table anywhere.

import { useCallback, useState } from "react";
import { P } from "@/lib/storage";
import { getAuthTokenWithCeremony } from "@/lib/auth-session";
import { fetchWithTimeout } from "@/lib/net";

const C = {
  bg: "#151312", card: "#1A1714", border: "#2D2924", text: "#EDEBE7",
  dim: "#A09890", faint: "#6B6560", coral: "#E0956A", sage: "#8BB09A", rose: "#C9A0B8",
};
const STATUS_TONE = { new: C.coral, in_scope: C.sage, filled: C.faint, killed: C.faint };
const TRANSITIONS = ["in_scope", "filled", "killed"];

export default function DiagBugs() {
  const [profile] = useState(() => (typeof window === "undefined" ? null : P.getActive()));
  const [token, setToken] = useState(null);
  const [reports, setReports] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const t = token || await getAuthTokenWithCeremony(profile);
      if (!t) { setErr("Ceremony cancelled."); return; }
      const res = await fetchWithTimeout("/api/bugs", { headers: { "X-HW-Auth": t } });
      if (!res.ok) { setErr(`HTTP ${res.status}`); return; }
      setToken(t);
      setReports((await res.json()).reports || []);
    } catch (e) {
      setErr(e?.message || "Failed");
    } finally { setBusy(false); }
  }, [profile, token]);

  const setStatus = async (id, status) => {
    const res = await fetchWithTimeout("/api/bugs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-HW-Auth": token },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
  };

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "52px 20px 40px", color: C.text, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: C.faint, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
        Fill or kill
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>Bug reports</h1>

      {!reports && (
        <button onClick={load} disabled={busy} style={{ padding: "12px 18px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, color: C.coral, fontSize: 13, cursor: "pointer" }}>
          {busy ? "…" : "Unlock the list (passkey)"}
        </button>
      )}
      {err && <div style={{ fontSize: 12, color: C.rose, marginTop: 10 }}>{err}</div>}

      {reports && reports.length === 0 && (
        <div style={{ fontSize: 13, color: C.dim }}>Nothing on the list. Either it&apos;s perfect or nobody&apos;s telling you otherwise.</div>
      )}

      {(reports || []).map((r) => (
        <div key={r.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: STATUS_TONE[r.status] || C.dim, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              #{r.id} · {r.status}
            </span>
            <span style={{ fontSize: 11, color: C.faint }}>
              {r.profile || "anon"} · {String(r.created_at).slice(0, 16).replace("T", " ")}
            </span>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 4 }}>{r.message}</div>
          {r.context?.route && <div style={{ fontSize: 11, color: C.faint, marginBottom: 8 }}>at {r.context.route}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {TRANSITIONS.filter((t) => t !== r.status).map((t) => (
              <button key={t} onClick={() => setStatus(r.id, t)} style={{ padding: "6px 12px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, color: t === "killed" ? C.rose : t === "filled" ? C.sage : C.coral, cursor: "pointer" }}>
                {t.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
