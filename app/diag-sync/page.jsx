"use client";

import Link from "next/link";
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
import { checkStoreHealth, collectStoreSnapshot } from "@/lib/store-health";
import { windowPressure } from "@/lib/analytics";
import { LIBRARY } from "@/lib/library";

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
  // Read-only instruments (Phase 5 reframing, 2026-07-14): invariant
  // results + window pressure, derived fresh per render like the snapshot.
  const health = !profile ? [] : checkStoreHealth(collectStoreSnapshot(profile));
  const pressure = !profile ? { lifts: [], binding: false } : windowPressure(H.get(profile));

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
      // Direct fetch (not blobPush) so we can read the server's actual
      // error body on non-2xx. blobPush wraps failures as "Push failed: 500"
      // and discards the JSON body — useful for the sync state machine,
      // useless for diagnosing what the route threw.
      const res = await fetch("/api/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, data: local }),
      });
      const bodyText = await res.text();
      if (res.ok) {
        setLastAction({
          type: "push",
          result: `OK ${res.status} — meta:${JSON.stringify(local.meta || {}).length}b, history:${(local.history || []).length} records · server: ${bodyText.slice(0, 300)}`,
          at: Date.now(),
        });
      } else {
        setLastAction({
          type: "push",
          result: `HTTP ${res.status} — ${bodyText.slice(0, 400)}`,
          at: Date.now(),
        });
      }
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

  // Force the Day-entry repair migration to run again. Clears the
  // daysRepaired_v1 gate flag so Days._maybeRepair will re-evaluate every
  // entry on the next read. Useful when a user reports that orphaned days
  // persist after a deploy — proves whether the repair logic matches the
  // actual broken state of their entries vs whether they have a different
  // problem entirely.
  const onForceRepair = useCallback(() => {
    if (!profile) return;
    setBusy("repair");
    try {
      const before = Days.getAll(profile);
      const beforeBroken = Object.values(before).filter(
        (e) => !e.completedType && !e.sessionId && !e.scheduledType
              && (!e.marks || Object.keys(e.marks).length === 0),
      ).length;
      LS.remove(`forge:${profile}:daysRepaired_v1`);
      Days._maybeRepair(profile);
      const after = Days.getAll(profile);
      const afterBroken = Object.values(after).filter(
        (e) => !e.completedType && !e.sessionId && !e.scheduledType
              && (!e.marks || Object.keys(e.marks).length === 0),
      ).length;
      setLastAction({
        type: "repair",
        result: `OK — broken entries before:${beforeBroken}, after:${afterBroken} (repaired ${beforeBroken - afterBroken})`,
        at: Date.now(),
      });
    } catch (e) {
      setLastAction({ type: "repair", result: `ERR — ${e?.message || e}`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  }, [profile]);

  // Read-only snapshot of every Day entry. Rendered as a compact list so we
  // can SEE the broken-state signature rather than infer it from aggregate
  // counts. Computed inline each render — Day entry counts are small (≤90
  // days typically) so cost is negligible.
  const dayEntries = !profile ? [] : Object.values(Days.getAll(profile))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 20);

  // Nuke the service worker + every cache, then reload. Equivalent to the
  // ?nosw=1 escape hatch in ServiceWorkerRegistrar but reachable from
  // inside the PWA (which has no address bar — typing ?nosw=1 isn't an
  // option). Use when a deploy didn't seem to land: the new sw.js is on
  // the server but the old one is still controlling this client.
  const onResetCache = useCallback(async () => {
    setBusy("reset");
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      setLastAction({ type: "reset", result: "OK — SW unregistered + caches cleared. Reloading…", at: Date.now() });
      // Small delay so the user reads the confirmation, then hard reload.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setLastAction({ type: "reset", result: `ERR — ${e?.message || e}`, at: Date.now() });
      setBusy(null);
    }
  }, []);

  if (!profile) {
    return (
      <div style={{ padding: 24, maxWidth: 430, margin: "0 auto", color: "#EDEBE7", fontFamily: "system-ui" }}>
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
      maxWidth: 430,
      margin: "0 auto",
      padding: "52px 24px 48px",
      // Transparent over the .forge-page substrate (grain + base) — an
      // opaque #131110 here covered the grain and mismatched both the
      // status-bar strip and Safari's chrome tone (#1D1A19, the grain-
      // lifted field), seen on device as bands at both ends.
      color: "#EDEBE7",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <Link href="/" style={{ display: "inline-block", marginBottom: 18, fontSize: 12, color: "#857D75", textDecoration: "none" }}>
        ← Home
      </Link>
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
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <Button onClick={onForceRepair} busy={busy === "repair"} variant="danger">Force-repair Day entries</Button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={onResetCache} busy={busy === "reset"} variant="danger">Reset cache &amp; reload</Button>
        </div>
      </Section>

      {/* Store health — every paid-for data-shape bug, checked forever.
          READ-ONLY by doctrine: detection is continuous, repairs stay
          one-shot reviewed migrations (wipe protocol). */}
      <Section title="Store health (read-only invariants)">
        {health.map((h) => (
          <Row key={h.check}
            label={h.check}
            value={h.ok ? "ok" : `FAIL${h.detail ? ` · ${h.detail}` : ""}`}
            dim={h.ok}
          />
        ))}
      </Section>

      {/* Window pressure — the progression-v2 gate made observable. The
          engine's per-lift window is 12; the decision arms the day any
          lift's flat run outgrows it. */}
      <Section title="Progression window pressure">
        <Row label="verdict"
          value={pressure.binding
            ? "BINDING — a flat run outgrew the 12-entry window; the v2 decision is armed"
            : "not yet binding — no pattern outgrows the window"}
          dim={!pressure.binding}
        />
        {pressure.lifts.slice(0, 6).map((l) => (
          <Row key={l.name}
            label={l.name}
            value={`${l.sessions} sessions · longest flat run ${l.longestFlatRun}${l.saturated ? " · window saturated" : ""}`}
            dim={!l.exceedsWindow}
          />
        ))}
        {pressure.lifts.length === 0 && <Row label="—" value="no main-lift history yet" dim />}
      </Section>

      <Section title="Day entries (latest 20)">
        <div style={{
          background: "#1A1714", border: "1px solid #2D2924", borderRadius: 8,
          padding: "10px 12px", fontSize: 11, fontFamily: "ui-monospace, monospace",
          maxHeight: 280, overflowY: "auto",
        }}>
          {dayEntries.length === 0 ? (
            <div style={{ color: "#6B6560" }}>no entries</div>
          ) : (
            dayEntries.map((e) => {
              const sched = e.scheduledType || "—";
              const done  = e.completedType || "—";
              const sid   = e.sessionId ? "S" : "·";
              const marks = e.marks && Object.keys(e.marks).length > 0
                ? Object.keys(e.marks).join(",") : "·";
              const broken = !e.completedType && !e.sessionId;
              return (
                <div key={e.date} style={{
                  display: "flex", justifyContent: "space-between",
                  padding: "4px 0", color: broken ? "#C9A0B8" : "#EDEBE7",
                }}>
                  <span>{e.date}</span>
                  <span style={{ color: "#A09890" }}>{`sched:${sched}`}</span>
                  <span style={{ color: "#A09890" }}>{`done:${done}`}</span>
                  <span style={{ color: "#A09890" }}>{`sid:${sid}`}</span>
                  <span style={{ color: "#A09890" }}>{`m:${marks}`}</span>
                </div>
              );
            })
          )}
        </div>
        <div style={{ fontSize: 11, color: "#6B6560", marginTop: 8, lineHeight: 1.55 }}>
          Rose = broken (no completedType, no sessionId). Force-repair re-runs
          the migration; rose lines should disappear or move to white.
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

      {/* For whoever reads a sync diagnostic all the way to the end: a door.
          The exercise library is deliberately unlinked anywhere else in the
          app — this line is its only in-app entrance. An easter egg, not a
          nav item; keep it dressed as a readout row. */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        padding: "8px 0", marginTop: 8, fontSize: 13,
      }}>
        <span style={{ color: "#6B6560" }}>exercise index</span>
        <Link href="/library" style={{
          fontFamily: "ui-monospace, monospace", color: "#6B6560",
          textDecoration: "none",
        }}>
          {LIBRARY.length} entries mapped →
        </Link>
      </div>
    </div>
  );
}
