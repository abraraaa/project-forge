"use client";

// components/sync-cards.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Sync-status UI cards, extracted from ForgeApp.jsx during the PR3 real-routes
// migration (stage 3c — sub-component decomposition). Both subscribe to
// SyncStatus and are self-contained (storage + tokens only, no app state), so
// the Profile route can import them once it's extracted. Behaviour-preserving
// move — definitions are verbatim from the monolith.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { SyncStatus, backgroundSync, pushNow } from "@/lib/storage";
import { T } from "@/lib/tokens";

// ─── Sync Status Card ──────────────────────────────────────────────────────────
export function SyncStatusCard({ profile }) {
  const [status, setStatus] = useState(SyncStatus.get());
  const [retrying, setRetrying] = useState(false);
  // Snapshot of "now" for the relative-time label. Refreshed whenever sync
  // status changes (the only moment the label needs to move), so render stays
  // pure — no Date.now() read mid-render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => SyncStatus.subscribe(s => { setStatus(s); setNow(Date.now()); }), []);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    await backgroundSync(profile, {
      onUpdate: () => {}, // State is handled by the parent component
    });
    setRetrying(false);
  };

  const formatTime = (ts) => {
    if (!ts) return "never";
    const diff = now - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  const stateLabel = {
    idle: "Synced",
    pulling: "Syncing...",
    pushing: "Saving...",
    error: "Offline",
  };

  const stateColour = {
    idle: T.sage,
    pulling: T.steel,
    pushing: T.steel,
    error: T.coral,
  };

  // Deliberately CLEAR — a status readout, not an interactive card (per the
  // 2026-07-08 unification: only actionable rows get the glass treatment).
  // Padding keeps the text aligned with card interiors.
  return (
    <div style={{
      marginTop: 16,
      padding: "14px 18px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: stateColour[status.state],
          animation: status.state === "pulling" || status.state === "pushing" ? "pulse 1s ease-in-out infinite" : "none",
        }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}>
            {stateLabel[status.state]}
          </div>
          {status.lastSync && status.state === "idle" && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Last sync: {formatTime(status.lastSync)}
            </div>
          )}
          {status.error && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Will retry when online
            </div>
          )}
        </div>
      </div>
      {status.state === "error" && (
        <button
          onClick={handleRetry}
          disabled={retrying}
          style={{
            padding: "8px 14px",
            background: T.bg3,
            border: `1px solid ${T.bg4}`,
            borderRadius: T.r.md,
            fontSize: 12,
            fontWeight: 500,
            color: T.text2,
            cursor: retrying ? "default" : "pointer",
            opacity: retrying ? 0.6 : 1,
          }}
        >
          {retrying ? "..." : "Retry"}
        </button>
      )}
    </div>
  );
}

// Sync now — manual flush of the local snapshot to blob. The auto-sync
// machinery (per-mutation pushNow, deferred-flush on lifecycle events) is
// the normal path; this row exists as power-user reassurance and as an
// escape hatch when observability looks stale. Subscribes to SyncStatus
// so the subtitle reflects the same state as the SyncStatusCard above.
export function SyncNowRow({ profile }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(SyncStatus.get());
  // `now` is snapshotted on mount + whenever sync status changes — same
  // pattern as SyncStatusCard. Keeps render pure (no Date.now read mid-
  // render, which the react-hooks/purity rule rightly flags) and the
  // label still updates when it meaningfully needs to (a push completed).
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const unsub = SyncStatus.subscribe(s => { setStatus(s); setNow(Date.now()); });
    // Per-second tick because the subtitle's unit is seconds — without
    // this the label freezes between sync events. Lint allows Date.now()
    // inside an interval callback; the render itself stays pure (reads
    // `now` from state, not the clock).
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsub(); clearInterval(tick); };
  }, []);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try { await pushNow(profile); } finally {
      setBusy(false);
      setNow(Date.now());
    }
  };

  const subtitle = busy
    ? "Syncing now…"
    : status.lastSync
      ? `Last sync ${Math.max(1, Math.round((now - status.lastSync) / 1000))}s ago`
      : "Never synced";

  return (
    <div onClick={handleClick} role="button" aria-label="Sync now" className="forge-glass"
      style={{ marginTop: 12, padding: "14px 18px", border: `1px solid ${T.bg3}`, borderRadius: T.r.lg, cursor: busy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", transition: `all 180ms ${T.ease}`, opacity: busy ? 0.7 : 1 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}>Sync now</div>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{subtitle}</div>
      </div>
      <span style={{ fontSize: 14, color: T.text3 }}>{busy ? "…" : "↻"}</span>
    </div>
  );
}
