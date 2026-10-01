// The identity backfill planner: rules P1–P13, the production census, and
// idempotence. Pure — no mocks needed.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { planIdentityBackfill, buildIdentityBackfill, backfillRpId } from "../lib/identity-backfill.js";
import { credentialRpId } from "../lib/auth-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(root, "lib/identity-backfill.js"), "utf8");

const sha256b64u = (s) => createHash("sha256").update(s).digest("base64url");
const NOW = "2026-10-01T12:00:00.000Z";
const PK_NATIVE = "pQECAyYgASFYIFAKEPUBLICKEYNATIVE000000000000000000000";
const PK_LEGACY = "pQECAyYgASFYIFAKEPUBLICKEYLEGACY000000000000000000000";

const blob = (dir, file, uploadedAt) => ({ pathname: `forge/profiles/${dir}/${file}`, uploadedAt, size: 100 });
const cred = (id, publicKey, extra = {}) => ({ id, publicKey, counter: 3, transports: ["internal"], createdAt: "2026-08-20T09:00:00.000Z", ...extra });

// Mirrors the 2026-10-01 production census: 1 profile, 2 credentials (one
// per rpId, both keyed), 1 photo.
const census = () => ({
  blobs: [
    blob("sam", "meta.json", "2026-05-01T08:00:00.000Z"),
    blob("sam", "credentials-x1.json", "2026-09-10T10:00:00.000Z"),
    blob("sam", "photos/2026-09-01.jpg", "2026-09-01T07:00:00.000Z"),
  ],
  credentialDocs: {
    sam: {
      pathname: "forge/profiles/sam/credentials-x1.json",
      uploadedAt: "2026-09-10T10:00:00.000Z",
      doc: {
        credentials: [
          cred("credNATIVE-0001", PK_NATIVE, { rpId: "heatwayve.app" }),
          cred("credLEGACY-0002", PK_LEGACY, { rpId: "theforged.fit" }),
        ],
        consent: { version: "2026-09", at: "2026-09-10T10:00:00.000Z" },
      },
    },
  },
  dbNames: { sessions: ["sam"], meta: ["sam"], photos: ["sam"], auth_tokens: ["sam"], oauth_grants: [], oauth_codes: [] },
  displayNames: { sam: "Sam" },
  existing: { accounts: [], handles: [], credentials: [] },
  now: NOW,
});

const counts = (plan) => ({
  accounts: plan.counts.accounts.create,
  handles: plan.counts.handles.create,
  credentials: plan.counts.credentials.create,
});

// What apply would leave behind: every planned row, with minted ids.
const appliedState = (writes) => {
  const ids = new Map(writes.accounts.map((a, i) => [a.storageKey, `hwa_${String(i).padStart(26, "a")}`]));
  return {
    accounts: [...ids].map(([storage_key, id]) => ({ id, storage_key })),
    handles: writes.handles.map((h) => ({ handle: h.handle, account_id: ids.get(h.storageKey) })),
    credentials: writes.credentials.map((c) => ({ id: c.id, account_id: ids.get(c.storageKey) })),
  };
};

const reasons = (plan) => plan.conflicts.map((c) => `${c.key}:${c.reason}`);

describe("identity backfill — today's census", () => {
  const { plan, writes } = buildIdentityBackfill(census());

  it("plans exactly 1 account, 1 handle, 2 credentials, all create", () => {
    expect(counts(plan)).toEqual({ accounts: 1, handles: 1, credentials: 2 });
    expect(plan.accounts.map((a) => a.status)).toEqual(["create"]);
    expect(plan.handles.map((h) => h.status)).toEqual(["create"]);
    expect(plan.credentials.map((c) => c.status)).toEqual(["create", "create"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.skipped.orphanReferences).toEqual([]);
    expect(plan.anomalies).toEqual([]);
  });

  it("account and handle rows carry the storage key, display and claim time", () => {
    expect(writes.accounts[0]).toMatchObject({
      storageKey: "sam", origin: "backfill", roles: ["lifter"], plan: "free",
      consent: { version: "2026-09", at: "2026-09-10T10:00:00.000Z" },
      evidence: { blobDir: true, sessions: true, meta: true, photos: true, tokens: true, grants: false, codes: false },
    });
    expect(writes.handles[0]).toEqual({
      handle: "sam", storageKey: "sam", display: "Sam", kind: "primary", claimedAt: "2026-05-01T08:00:00.000Z",
    });
  });

  it("keeps today's user handle and each credential's rpId", () => {
    for (const c of writes.credentials) expect(c.userHandle).toBe(sha256b64u("sam"));
    expect(writes.credentials.map((c) => c.rpId).sort()).toEqual(["heatwayve.app", "theforged.fit"]);
    expect(writes.credentials.every((c) => c.rpIdInferred === false)).toBe(true);
  });

  it("plans only creates — no row is ever planned for delete or overwrite", () => {
    const statuses = [...plan.accounts, ...plan.handles, ...plan.credentials].map((r) => r.status);
    for (const s of statuses) expect(["create", "present", "conflict"]).toContain(s);
    expect(Object.keys(writes).sort()).toEqual(["accounts", "credentials", "handles"]);
    expect(src).not.toMatch(/\b(DELETE|UPDATE|DROP)\b|\bdel\s*\(|\bput\s*\(|@vercel\/blob|\.\/db\.js/);
  });
});

describe("identity backfill — idempotence", () => {
  it("re-planning against the applied state plans 0 creates, all present", () => {
    const first = buildIdentityBackfill(census());
    const again = planIdentityBackfill({ ...census(), existing: appliedState(first.writes) });
    expect(counts(again)).toEqual({ accounts: 0, handles: 0, credentials: 0 });
    for (const r of [...again.accounts, ...again.handles, ...again.credentials]) expect(r.status).toBe("present");
    expect(again.conflicts).toEqual([]);
  });

  it("the empty plan has one stable hash", () => {
    const first = buildIdentityBackfill(census());
    const a = planIdentityBackfill({ ...census(), existing: appliedState(first.writes) });
    const b = planIdentityBackfill({ ...census(), existing: appliedState(first.writes), now: "2027-01-01T00:00:00.000Z" });
    const empty = createHash("sha256").update(JSON.stringify({ accounts: [], handles: [], credentials: [] })).digest("hex");
    expect(a.planHash).toBe(empty);
    expect(b.planHash).toBe(empty);
    expect(first.plan.planHash).not.toBe(empty);
  });
});

describe("identity backfill — rules", () => {
  it("P1: data-bearing keys come from blob dirs and sessions/meta/photos", () => {
    const plan = planIdentityBackfill({
      ...census(),
      blobs: [blob("caf%C3%A9", "meta.json", "2026-06-01T00:00:00.000Z")],
      credentialDocs: {},
      dbNames: { sessions: ["ana"], meta: ["bo"], photos: ["cy"] },
    });
    expect(plan.accounts.map((a) => a.storageKey)).toEqual(["ana", "bo", "café", "cy"]);
  });

  it("P2: retired photo keys are excluded and counted", () => {
    const plan = planIdentityBackfill({
      ...census(),
      dbNames: { ...census().dbNames, photos: ["sam", "sam/retired/2026-09-01T00:00:00.000Z", "bo/retired/x"] },
    });
    expect(plan.skipped.retiredPhotoKeys).toBe(2);
    expect(plan.accounts.map((a) => a.storageKey)).toEqual(["sam"]);
  });

  it("P3: a key found only in tokens/grants/codes is an orphan reference with no account", () => {
    const plan = planIdentityBackfill({
      ...census(),
      dbNames: { ...census().dbNames, oauth_grants: ["gone"], oauth_codes: ["gone"], auth_tokens: ["sam", "left"] },
    });
    expect(plan.skipped.orphanReferences).toEqual([
      { key: "gone", sources: ["oauth_grants", "oauth_codes"] },
      { key: "left", sources: ["auth_tokens"] },
    ]);
    expect(plan.accounts.map((a) => a.storageKey)).toEqual(["sam"]);
    expect(plan.handles.map((h) => h.handle)).toEqual(["sam"]);
  });

  it("P4: a non-canonical key is a conflict and plans nothing", () => {
    const plan = planIdentityBackfill({ ...census(), dbNames: { ...census().dbNames, sessions: ["sam", "Sam"] } });
    expect(reasons(plan)).toEqual(["Sam:non-canonical"]);
    expect(plan.accounts.map((a) => a.storageKey)).toEqual(["sam"]);
  });

  it("P5: an account-id-shaped key is a conflict", () => {
    const k = `hwa_${"a".repeat(26)}`;
    const plan = planIdentityBackfill({ ...census(), dbNames: { ...census().dbNames, meta: ["sam", k] } });
    expect(reasons(plan)).toEqual([`${k}:collides with account-id shape`]);
    expect(plan.accounts.map((a) => a.storageKey)).toEqual(["sam"]);
  });

  it("P6: consent only when well-formed; other doc keys reported, not carried", () => {
    const input = census();
    input.credentialDocs.sam.doc.consent = { version: 2, at: "x" };
    input.credentialDocs.sam.doc.connections = [];
    input.credentialDocs.sam.doc.zeta = 1;
    const { writes } = buildIdentityBackfill(input);
    expect(writes.accounts[0].consent).toBeNull();
    expect(writes.accounts[0].otherDocKeys).toEqual(["connections", "zeta"]);
  });

  it("P7: a db-only key claims at now and is flagged; display falls back to the key", () => {
    const plan = planIdentityBackfill({ ...census(), dbNames: { ...census().dbNames, sessions: ["sam", "ana"] } });
    const ana = plan.handles.find((h) => h.handle === "ana");
    expect(ana).toMatchObject({ claimedAt: NOW, display: "ana", status: "create" });
    expect(plan.anomalies).toEqual([{ key: "ana", reason: "db-only (no claim marker)" }]);
  });

  it("P8: absent rpId is inferred as theforged.fit, matching credentialRpId", () => {
    const input = census();
    const { rpId: _drop, ...noRp } = input.credentialDocs.sam.doc.credentials[1];
    input.credentialDocs.sam.doc.credentials[1] = noRp;
    const plan = planIdentityBackfill(input);
    const legacy = plan.credentials.find((c) => c.idPrefix === "credLEGA");
    expect(legacy).toMatchObject({ rpId: "theforged.fit", rpIdInferred: true });
    for (const c of [{}, { rpId: "" }, { rpId: "heatwayve.app" }, { rpId: 7 }, null]) {
      expect(backfillRpId(c)).toBe(credentialRpId(c));
    }
  });

  it("P8: keyless credentials are skipped; bad createdAt becomes null; counter and transports default", () => {
    const input = census();
    input.credentialDocs.sam.doc.credentials.push({ id: "keylessID-9", attestation: "raw" });
    input.credentialDocs.sam.doc.credentials[0] = { id: "credNATIVE-0001", publicKey: PK_NATIVE, rpId: "heatwayve.app", createdAt: "nope" };
    const { plan, writes } = buildIdentityBackfill(input);
    expect(plan.skipped.keyless).toEqual([{ storageKey: "sam", idPrefix: "keylessI" }]);
    expect(writes.credentials).toHaveLength(2);
    expect(writes.credentials.find((c) => c.id === "credNATIVE-0001")).toMatchObject({ counter: 0, transports: [], createdAt: null });
  });

  it("P9: an unreadable credentials doc is a conflict, never zero credentials", () => {
    const input = census();
    input.credentialDocs.sam.doc = null;
    const plan = planIdentityBackfill(input);
    expect(reasons(plan)).toEqual(["sam:credentials unreadable"]);
    expect(plan.credentials).toEqual([]);
  });

  it("P9: a credentials blob with no gathered doc is also a conflict", () => {
    const plan = planIdentityBackfill({ ...census(), credentialDocs: {} });
    expect(reasons(plan)).toEqual(["sam:credentials unreadable"]);
  });

  it("P10: one credential id under two directories conflicts for both, planned for neither", () => {
    const input = census();
    input.blobs.push(blob("bo", "credentials-y.json", "2026-09-11T00:00:00.000Z"));
    input.credentialDocs.bo = { doc: { credentials: [cred("credLEGACY-0002", PK_LEGACY)] } };
    const plan = planIdentityBackfill(input);
    expect(reasons(plan)).toEqual(["bo:credential id under two directories", "sam:credential id under two directories"]);
    expect(plan.credentials.map((c) => c.idPrefix)).toEqual(["credNATI"]);
  });

  it("P11: a live handle on an account with a different storage key is a conflict", () => {
    const plan = planIdentityBackfill({
      ...census(),
      existing: { accounts: [{ id: "hwa_other", storage_key: "hwa_other" }], handles: [{ handle: "sam", account_id: "hwa_other" }], credentials: [] },
    });
    expect(plan.handles[0].status).toBe("conflict");
    expect(reasons(plan)).toEqual(["sam:live handle on another account"]);
  });

  it("P11: a credential id on a different account is a conflict", () => {
    const plan = planIdentityBackfill({
      ...census(),
      existing: { accounts: [{ id: "hwa_b", storage_key: "bo" }], handles: [], credentials: [{ id: "credNATIVE-0001", account_id: "hwa_b" }] },
    });
    expect(plan.credentials.find((c) => c.idPrefix === "credNATI").status).toBe("conflict");
    expect(reasons(plan)).toEqual(["sam:credential on another account"]);
  });

  it("P11: account present but handle missing plans only the handle", () => {
    const plan = planIdentityBackfill({
      ...census(),
      existing: {
        accounts: [{ id: "hwa_a", storage_key: "sam" }], handles: [],
        credentials: [{ id: "credNATIVE-0001", account_id: "hwa_a" }, { id: "credLEGACY-0002", account_id: "hwa_a" }],
      },
    });
    expect(counts(plan)).toEqual({ accounts: 0, handles: 1, credentials: 0 });
  });

  it("P12: shuffled inputs give an identical plan and hash", () => {
    const a = census();
    a.dbNames.sessions = ["sam", "ana", "zed"];
    a.blobs.push(blob("bo", "meta.json", "2026-06-01T00:00:00.000Z"));
    const b = structuredClone(a);
    b.blobs.reverse();
    b.dbNames.sessions.reverse();
    b.credentialDocs.sam.doc.credentials.reverse();
    b.credentialDocs = Object.fromEntries(Object.entries(b.credentialDocs).reverse());
    const pa = planIdentityBackfill(a);
    const pb = planIdentityBackfill(b);
    expect(pb.planHash).toBe(pa.planHash);
    expect(pb).toEqual(pa);
  });

  it("P12: the hash moves when a planned row changes, and ignores `now` for db-only claims", () => {
    const base = census();
    base.dbNames.sessions = ["sam", "ana"];
    const h = planIdentityBackfill(base).planHash;
    expect(planIdentityBackfill({ ...base, now: "2026-10-02T00:00:00.000Z" }).planHash).toBe(h);
    const changed = structuredClone(base);
    changed.credentialDocs.sam.doc.credentials[0].publicKey = PK_NATIVE + "x";
    expect(planIdentityBackfill(changed).planHash).not.toBe(h);
  });

  it("P13: the report contains no public key and no full credential id", () => {
    const json = JSON.stringify(planIdentityBackfill(census()));
    for (const s of [PK_NATIVE, PK_LEGACY, "credNATIVE-0001", "credLEGACY-0002"]) expect(json).not.toContain(s);
    const { writes } = buildIdentityBackfill(census());
    expect(JSON.stringify(writes)).toContain(PK_NATIVE);
  });
});
