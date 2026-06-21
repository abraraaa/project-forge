"use client";

// app/diag-sync/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Sync diagnostic page. Surfaces the actual state of every persisted store
// for the active profile + lets you manually trigger pull / push / fold to
// confirm round-trip behaviour without guessing.
//
// Purpose: when a sync issue is reported ("Safari shows 0 history, PWA
// shows 6 sessions"), this page gives evidence — last sync timestamp +
// counts per store + the ability to force a clean pull/push and watch
// what changes. Same pattern as /diag-vt: observable behaviour from a
// controlled environment, not inference from production symptoms.
//
// Not wired into navigation — visit /diag-sync directly. No effect on
// the rest of the app's behaviour.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  LS, P, H, W, PB, F, BW, TS, Days, PQ, SyncStatus,
  backgroundSync, blobPull, blobPush, flushPendingPushes,
  getLocalProfile,
} from "@/lib/storage";

function fmtTs(ts) {
  if (!ts) return "never";
  const ms = Date.now() - ts;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString();
}

function Row({ label, value, dim }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 16,
      padding: "8px 0", borderBottom: "1px solid #2D2924",
      fontSize: 13, color: dim ? "#6B6560" : "#EDEBE7",
    }}>
      <span style={{ color: "#A09890" }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: "#6B6560",
        letterSpacing: "0.14em", textTransform: "uppercase",
        marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "default", busy = false }) {
  const bg = busy ? "#2D2924" :
             variant === "danger" ? "#3a1f1c" : "#1A1714";
  const border = busy ? "#403C38" :
                 variant === "danger" ? "#C9A0B833" : "#403C38";
  const color = busy ? "#6B6560" :
                variant === "danger" ? "#C9A0B8" : "#E0956A";
  return (
    <button onClick={onClick} disabled={busy} style={{
      flex: 1, padding: "12px 14px", background: bg,
      border: `1px solid ${border}`, borderRadius: 12,
      color, fontSize: 13, fontWeight: 500, cursor: busy ? "wait" : "pointer",
      WebkitTapHighlightColor: "transparent",
    }}>
      {busy ? "…" : children}
    </button>
  );
}

export default function DiagSync() {
  // Lazy initialisers — localStorage reads during render are impure, the
  // function-form useState arg only runs on mount so it doesn't trip the
  // react-hooks/purity rule.
  const [profile] = useState(() =>
    typeof window === "undefined" ? null : P.getActive(),
  );
  const [status, setStatus] = useState(() => SyncStatus.get());
  const [, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(null); // "pull" | "push" | "fold" | null
  const [lastAction, setLastAction] = useState(null);

  // Subscribe + 1s ticker to refresh displayed "x seconds ago" strings.
  // setNow re-renders the whole tree which is fine for a diag page.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const unsub = SyncStatus.subscribe(setStatus);
    return () => { clearInterval(tick); unsub(); };
  }, []);

  // Snapshot computed inline — every render picks up fresh localStorage
  // reads. Cheap (sub-millisecond) for the sizes we deal with, and re-
  // running every tick / after each action is the desired behaviour for a
  // diagnostic surface. Suppress lint warning on missing key fields here;
  // intentional decision rather than oversight. Returning null when
  // profile is missing so the early-return below works.
  const snapshot = !profile ? null : {
    historyCount: H.get(profile).length,
    daysCount: Object.keys(Days.getAll(profile)).length,
    manualTickCount: Object.keys(Days.manualTickDates(profile)).length,
    scheduleEditCount: (W.getHistory() || []).length,
    programmeBlockNumber: (PB.get() || {}).number || null,
    focus: F.get(profile),
    bwKg: BW.getKg(profile),
    tsLifts: Object.keys((TS.get(profile) || {}).lifts || {}).length,
    tsAnchors: Object.keys((TS.get(profile) || {}).muscleAnchors || {}).length,
    pendingPushes: PQ.get().length,
    metaSize: JSON.stringify(getLocalProfile(profile).meta || {}).length,
    historySize: JSON.stringify(getLocalProfile(profile).history || []).length,
  };

  const onPull = useCallback(async () => {
    if (!profile) return;
    setBusy("pull");
    try {
      const remote = await blobPull(profile);
      setLastAction({
        type: "pull",
        result: remote ? `OK — meta:${JSON.stringify(remote.meta || {}).length}b, history:${(remote.history || []).length} records` : "null (blob empty or unreachable)",
        at: Date.now(),
      });
    } catch (e) {
      setLastAction({ type: "pull", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  const onPush = useCallback(async () => {
    if (!profile) return;
    setBusy("push");
    try {
      const local = getLocalProfile(profile);
      const ok = await blobPush(profile, local);
      setLastAction({
        type: "push",
        result: ok ? `OK — meta:${JSON.stringify(local.meta || {}).length}b, history:${(local.history || []).length} records` : "FAILED — queued for retry",
        at: Date.now(),
      });
    } catch (e) {
      setLastAction({ type: "push", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  const onForceSync = useCallback(async () => {
    if (!profile) return;
    setBusy("sync");
    try {
      const result = await backgroundSync(profile, {
        onUpdate: () => {},
        onError: (e) => { throw e; },
      });
      setLastAction({
        type: "sync",
        result: `OK — source:${result?.source || "?"}, changed:${result?.changed ?? "?"}`,
        at: Date.now(),
      });
    } catch (e) {
      setLastAction({ type: "sync", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  const onFlushQueue = useCallback(async () => {
    if (!profile) return;
    setBusy("flush");
    try {
      const count = await flushPendingPushes((p) => getLocalProfile(p));
      setLastAction({ type: "flush", result: `OK — flushed ${count} pending`, at: Date.now() });
    } catch (e) {
      setLastAction({ type: "flush", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  const onFoldLegacy = useCallback(() => {
    if (!profile) return;
    setBusy("fold");
    try {
      LS.remove(`forge:${profile}:daysProjected`);
      Days._foldLegacy(profile);
      setLastAction({ type: "fold", result: `OK — Day store rebuilt from dayDone/bonusDone/history`, at: Date.now() });
    } catch (e) {
      setLastAction({ type: "fold", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  if (!profile) {
    return (
      <div style={{ padding: 24, color: "#EDEBE7", fontFamily: "system-ui" }}>
        <div style={{ fontSize: 22, marginBottom: 8 }}>Sync diagnostic</div>
        <div style={{ color: "#A09890" }}>
          No active profile. Sign in via the main app first, then return here.
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      padding: "52px 24px 48px",
      background: "#131110",
      color: "#EDEBE7",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ fontSize: 11, color: "#6B6560", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>
        Sync diagnostic
      </div>
      <div style={{ fontSize: 26, fontWeight: 300, marginBottom: 4 }}>
        {profile}
      </div>
      <div style={{ fontSize: 12, color: "#A09890", marginBottom: 24 }}>
        {`Sync state: ${status.state} · Last sync: ${fmtTs(status.lastSync)}${status.error ? " · ERR: " + status.error : ""}`}
      </div>

      <Section title="Local snapshot">
        <Row label="history records"          value={snapshot.historyCount} />
        <Row label="Day entries"              value={snapshot.daysCount} />
        <Row label="manual ticks (read)"      value={snapshot.manualTickCount} />
        <Row label="schedule edits"           value={snapshot.scheduleEditCount} />
        <Row label="programme block #"        value={snapshot.programmeBlockNumber ?? "—"} />
        <Row label="focus"                    value={snapshot.focus} />
        <Row label="bodyweight (kg)"          value={snapshot.bwKg ?? "—"} />
        <Row label="TS lifts tracked"         value={snapshot.tsLifts} />
        <Row label="TS muscle anchors"        value={snapshot.tsAnchors} />
        <Row label="meta payload size"        value={`${snapshot.metaSize}b`} dim />
        <Row label="history payload size"     value={`${snapshot.historySize}b`} dim />
        <Row label="pending pushes (queue)"   value={snapshot.pendingPushes} />
      </Section>

      <Section title="Actions">
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <Button onClick={onPull} busy={busy === "pull"}>Force pull</Button>
          <Button onClick={onPush} busy={busy === "push"}>Force push</Button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <Button onClick={onForceSync} busy={busy === "sync"}>Full sync (pull+merge+push)</Button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <Button onClick={onFlushQueue} busy={busy === "flush"}>Flush pending queue</Button>
          <Button onClick={onFoldLegacy} busy={busy === "fold"} variant="danger">Re-fold legacy</Button>
        </div>
      </Section>

      {lastAction && (
        <Section title="Last action">
          <Row label={lastAction.type} value={fmtTs(lastAction.at)} dim />
          <div style={{
            padding: "12px 14px", marginTop: 8,
            background: "#1A1714", border: "1px solid #2D2924", borderRadius: 8,
            fontSize: 12, fontFamily: "ui-monospace, monospace",
            wordBreak: "break-word",
          }}>{lastAction.result}</div>
        </Section>
      )}

      <Section title="What each action does">
        <div style={{ fontSize: 12, color: "#A09890", lineHeight: 1.6 }}>
          <div><strong>Force pull</strong> — fetches the blob via blobPull, shows what's actually there. Does NOT merge or persist; pure read of remote state.</div>
          <div style={{ marginTop: 6 }}><strong>Force push</strong> — calls blobPush with current local snapshot. Use to confirm the push reaches the blob successfully.</div>
          <div style={{ marginTop: 6 }}><strong>Full sync</strong> — same backgroundSync the app runs on profile change / visibility return. Pulls, merges with local per the merge rules, persists, returns {`{source, changed}`}.</div>
          <div style={{ marginTop: 6 }}><strong>Flush pending queue</strong> — fires any deferred pushes that failed on previous events.</div>
          <div style={{ marginTop: 6 }}><strong>Re-fold legacy</strong> — clears the projection-done flag and re-runs Days._foldLegacy to project dayDone/bonusDone/history into Day entries. Idempotent on existing Day entries (preserves them); only fills in missing dates.</div>
        </div>
      </Section>
    </div>
  );
}
