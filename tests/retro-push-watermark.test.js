// @vitest-environment jsdom
// tests/retro-push-watermark.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The P0 from the 2026-07-26 deep audit: retro-logged sessions were silently
// lost on delta-mode devices, permanently.
//
// THE BUG. A retro record's id is anchored to the DATE TRAINED (noon UTC of
// the retro date) so it sorts into the right place in history. The delta push
// selected "new records" with `id > lastRecordId`, and the watermark only
// ever moves forward. So the moment a device had pushed anything newer than
// the retro date, the retro record sat permanently BELOW the watermark and
// was never shipped — to the DB or to any other device.
//
// WHY IT WAS SILENT, and why nothing rescued it: recordCompletion dirties
// `days`/`trainingState`/`weights`, so the delta push was non-empty and
// SUCCEEDED. The pending queue cleared. The full-history rescue path only
// runs when there is no cursor, and a delta device always has one. Worse, the
// `days` meta that DID sync carried a sessionId pointing at a record that
// never arrived — so other devices showed "strength complete" with no session
// behind it. Divergence, plus the workout's sets and volume lost from cloud.
//
// THE FIX. Separate the two orderings that were conflated:
//   · id      — RECORD ordering (where it sits in training history)
//   · pushKey — PUSH ordering (when this device created the row)
// They coincide for live sessions and diverge for retro ones.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DeltaSync, pushKey, needsReconcile, PUSH_STATE_VERSION } from "../lib/sync-delta.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The exact shapes ForgeApp produces.
const live = (iso) => ({ id: iso, date: iso.slice(0, 10) });
const retro = (trainedDate, loggedAtIso) => ({
  id: `${trainedDate}T12:00:00.000Z`,   // anchored to the date TRAINED
  date: trainedDate,
  loggedAt: loggedAtIso,                 // when the user actually typed it
  retrospective: true,
});

describe("pushKey — the push-ordering key", () => {
  it("is the id for a live session (the id IS its creation instant)", () => {
    expect(pushKey(live("2026-07-26T09:00:00.000Z"))).toBe("2026-07-26T09:00:00.000Z");
  });

  it("is loggedAt for a retro session — the moment the device created the row", () => {
    const r = retro("2026-07-20", "2026-07-26T10:00:00.000Z");
    expect(pushKey(r)).toBe("2026-07-26T10:00:00.000Z");
    expect(pushKey(r)).not.toBe(r.id);   // the whole point
  });

  it("never drags the key BACKWARDS from the id", () => {
    // max(), not `loggedAt ?? id`: a malformed or backdated loggedAt must not
    // re-strand a record below the watermark — that is the bug, re-entering
    // through a different door.
    const backdated = { id: "2026-07-26T09:00:00.000Z", loggedAt: "2020-01-01T00:00:00.000Z" };
    expect(pushKey(backdated)).toBe("2026-07-26T09:00:00.000Z");
    expect(pushKey({})).toBe("");
    expect(pushKey(null)).toBe("");
  });
});

describe("THE REGRESSION: a retro session logged after a newer live one", () => {
  // Reproduces the audit's exact scenario.
  const history = [
    retro("2026-07-20", "2026-07-26T10:00:00.000Z"), // caught up a missed Monday…
    live("2026-07-26T09:00:00.000Z"),                 // …after today's session
  ];

  it("ships the retro record even though its id predates the watermark", () => {
    // Watermark as it stands after today's live session was pushed.
    const watermark = "2026-07-26T09:00:00.000Z";
    const shipped = DeltaSync.newRecords(history, watermark);
    const ids = shipped.map((r) => r.id);
    expect(ids).toContain("2026-07-20T12:00:00.000Z");
  });

  it("the OLD id-based rule would have dropped it — proving the test bites", () => {
    const watermark = "2026-07-26T09:00:00.000Z";
    const oldRule = history.filter((r) => r.id > watermark);
    expect(oldRule.map((r) => r.id)).not.toContain("2026-07-20T12:00:00.000Z");
  });

  it("the watermark advances by pushKey, so the retro is not re-shipped forever", () => {
    DeltaSync.commitPushState("wm", { meta: {}, history });
    const after = DeltaSync.getPushState("wm");
    expect(after.lastRecordId).toBe("2026-07-26T10:00:00.000Z"); // the retro's loggedAt
    expect(DeltaSync.newRecords(history, after.lastRecordId)).toEqual([]);
  });

  it("a retro logged for a date the device HAS already pushed still ships once", () => {
    DeltaSync.commitPushState("wm2", { meta: {}, history: [live("2026-07-26T09:00:00.000Z")] });
    const w = DeltaSync.getPushState("wm2").lastRecordId;
    const late = retro("2026-07-19", "2026-07-27T08:00:00.000Z");
    expect(DeltaSync.newRecords([...history, late], w).map((r) => r.id))
      .toContain("2026-07-19T12:00:00.000Z");
  });
});

describe("one-time reconciliation for devices carrying the old watermark", () => {
  it("a v1 (unversioned) push-state needs reconciling", () => {
    expect(needsReconcile({ fieldHashes: {}, lastRecordId: "x" })).toBe(true);
    expect(needsReconcile({})).toBe(true);
    expect(needsReconcile(undefined)).toBe(true);
  });

  it("a freshly-committed push-state does NOT — it fires once per device, never again", () => {
    DeltaSync.commitPushState("rec", { meta: {}, history: [] });
    const st = DeltaSync.getPushState("rec");
    expect(st.v).toBe(PUSH_STATE_VERSION);
    expect(needsReconcile(st)).toBe(false);
  });

  it("pushNow routes a v1 device to the FULL push — the only thing that carries a record already below the watermark", () => {
    const s = readFileSync(resolve(root, "lib/storage.js"), "utf8");
    const fn = s.slice(s.indexOf("export async function pushNow"));
    const reconcileAt = fn.indexOf("needsReconcile(state)");
    expect(reconcileAt).toBeGreaterThan(-1);
    // Must come BEFORE the delta diff, or the stranded record is filtered out
    // before anyone thinks to reconcile.
    expect(reconcileAt).toBeLessThan(fn.indexOf("DeltaSync.newRecords"));
    expect(fn.slice(reconcileAt, reconcileAt + 120)).toContain("blobPush(profile, data)");
  });
});

describe("the false invariant that hid the bug is gone", () => {
  it("the header no longer claims retro records mint now() ids", () => {
    const s = readFileSync(resolve(root, "lib/sync-delta.js"), "utf8");
    expect(s).not.toContain("retro-logged sessions still mint now() ids and are never missed");
    // The contract must stay documented, but assert the INVARIANT rather than
    // one exact sentence — a prose-pinned lock breaks on harmless rewording
    // and gets "fixed" by deleting the documentation.
    expect(s).toMatch(/push[- ]ordering key/i);
    expect(s).toMatch(/pushKey[^\n]*\bnever\b[^\n]*raw record id/i);
  });

  it("retro records still sort by DATE TRAINED — the fix must not move them", () => {
    // The id anchoring is deliberate: history is ordered by id, so a retro
    // session belongs at its training date, not at the moment it was typed.
    // Fixing the watermark must not have "fixed" this too.
    const src = readFileSync(resolve(root, "components/ForgeApp.jsx"), "utf8");
    expect(src).toContain("draft.id   = `${retroDate}T12:00:00.000Z`");
    expect(src).toContain("draft.loggedAt");
  });
});
