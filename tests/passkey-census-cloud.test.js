// Cloud data with no usable passkey: the pure count, and the route with Blob
// and Neon mocked (reads only).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { censusPasskeys, cloudExposure, censusLogLine } from "../lib/passkey-census.js";
import { NATIVE_RP_ID, LEGACY_RP_ID } from "../lib/origin.js";

const doc = (profile, creds) => ({
  profile, pathname: `forge/profiles/${profile}/credentials.json`,
  uploadedAt: "2026-08-01T00:00:00Z", size: 10, doc: creds === null ? null : { credentials: creds },
});
const A = (c) => "hwa_" + c.repeat(26);

describe("cloudExposure", () => {
  it("counts cloud profiles with no usable credential, split by record", () => {
    const census = censusPasskeys([
      doc("usable", [{ id: "1", publicKey: "k", rpId: NATIVE_RP_ID }]),
      doc("legacy", [{ id: "2", publicKey: "k", rpId: LEGACY_RP_ID }]),
      doc("keyless", [{ id: "3" }]),
      doc("unread", null),
    ]);
    const r = cloudExposure(census, {
      syncKeys: ["usable", "legacy", "keyless", "unread", "bare", "indexed"],
      accounts: [{ id: A("a"), storageKey: "rowonly" }, { id: A("b"), storageKey: "indexed" }, { id: A("c"), storageKey: "lapsedidx" }],
      indexCredentials: [
        { accountId: A("b"), rpId: NATIVE_RP_ID, keyed: true },
        { accountId: A("c"), rpId: LEGACY_RP_ID, keyed: true },
      ],
    });
    expect(r.db).toBe(true);
    expect(r.profilesWithCloudData).toBe(8);
    expect(r.withSyncBlob).toBe(6);
    expect(r.withAccountRow).toBe(3);
    // legacy, keyless, unread, lapsedidx have records; bare, rowonly have none.
    expect(r.noUsableCredential).toBe(6);
    expect(r.noUsableWithRecord).toBe(4);
    expect(r.noUsableNoRecord).toBe(2);
  });

  it("a usable index row protects a profile whose doc has none", () => {
    const census = censusPasskeys([doc("sam", [{ id: "1", publicKey: "k", rpId: LEGACY_RP_ID }])]);
    const r = cloudExposure(census, {
      syncKeys: ["sam"],
      accounts: [{ id: A("a"), storageKey: "sam" }],
      indexCredentials: [{ accountId: A("a"), rpId: NATIVE_RP_ID, keyed: true }],
    });
    expect(r.noUsableCredential).toBe(0);
  });

  it("an unkeyed index row is a record, not a usable credential", () => {
    const r = cloudExposure(censusPasskeys([]), {
      accounts: [{ id: A("a"), storageKey: "sam" }],
      indexCredentials: [{ accountId: A("a"), rpId: NATIVE_RP_ID, keyed: false }],
    });
    expect(r.noUsableCredential).toBe(1);
    expect(r.noUsableWithRecord).toBe(1);
  });

  it("a profile with credentials but no cloud data is not counted", () => {
    const r = cloudExposure(censusPasskeys([doc("ghost", [{ id: "1" }])]), { syncKeys: [], accounts: [], indexCredentials: [] });
    expect(r.profilesWithCloudData).toBe(0);
    expect(r.noUsableCredential).toBe(0);
  });

  it("reports db false when Neon was not read", () => {
    const r = cloudExposure(censusPasskeys([]), { syncKeys: ["sam"] });
    expect(r.db).toBe(false);
    expect(r.noUsableNoRecord).toBe(1);
  });

  it("the log line carries the counts and no name", () => {
    const census = censusPasskeys([]);
    const cloud = cloudExposure(census, { syncKeys: ["verydistinctivename"], accounts: [], indexCredentials: [] });
    const line = censusLogLine(census, null, cloud);
    expect(line).toContain("cloud=1");
    expect(line).toContain("cloudNoUsable=1");
    expect(line).toContain("cloudWithRecord=0");
    expect(line).toContain("cloudNoRecord=1");
    expect(line).toContain("db=1");
    expect(line).not.toContain("verydistinctivename");
  });
});

const routeSrc = readFileSync(new URL("../app/api/diag/passkey-census/route.js", import.meta.url), "utf8");

describe("passkey census route — Neon reads only", () => {
  it("runs no statement that writes", () => {
    expect(routeSrc).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|ALTER|TRUNCATE|CREATE)\b/);
    expect(routeSrc).not.toMatch(/ensureSchema/);
    // No key material is selected.
    expect(routeSrc).not.toMatch(/SELECT[^`]*\bpublic_key\b\s*(,|FROM)/);
  });
});

const blobs = { list: [] };
const queries = [];
const dbState = { on: true, fail: false };
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: blobs.list, cursor: undefined })) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null }));
vi.mock("@/lib/blob-utils", () => ({
  readJsonDirect: vi.fn(async (p) => (p.includes("/lapsedname/") ? { credentials: [{ id: "x", publicKey: "k", rpId: LEGACY_RP_ID }] } : null)),
}));
vi.mock("@/lib/db", () => ({
  sql: () => {
    if (!dbState.on) return null;
    return async (strings) => {
      const text = strings.join("?");
      queries.push(text);
      if (dbState.fail) throw new Error("boom");
      if (/FROM accounts/.test(text)) return [{ id: A("a"), storage_key: "rowonly" }, { id: A("b"), storage_key: "safe" }];
      if (/FROM credentials/.test(text)) return [{ account_id: A("b"), rp_id: NATIVE_RP_ID, keyed: true }];
      return [];
    };
  },
}));

const { GET } = await import("../app/api/diag/passkey-census/route.js");
const req = () => new Request("http://localhost/api/diag/passkey-census", { headers: { authorization: "Bearer s3cret" } });
const path = (p) => ({ pathname: `forge/profiles/${p}`, uploadedAt: new Date("2026-08-01"), size: 5 });

describe("passkey census route — cloud exposure", () => {
  let log;
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    queries.length = 0;
    dbState.on = true;
    dbState.fail = false;
    blobs.list = [
      path("lapsedname/credentials.json"), path("lapsedname/meta.json"),
      path("bare/history.json"),
      path("safe/meta.json"),
      path("bare/photos/2026-08-01.jpg"),
    ];
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CRON_SECRET; });

  it("answers the count from Blob and Neon in one run, with SELECTs only", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cloud).toMatchObject({
      db: true, profilesWithCloudData: 4, noUsableCredential: 3, noUsableWithRecord: 1, noUsableNoRecord: 2,
    });
    expect(queries.length).toBe(2);
    for (const q of queries) expect(q.trim().startsWith("SELECT")).toBe(true);
    const line = log.mock.calls.map((c) => c[0]).find((l) => String(l).startsWith("[forge:passkey-census]"));
    expect(line).toContain("cloudNoUsable=3");
    for (const n of ["lapsedname", "bare", "safe", "rowonly"]) expect(line).not.toMatch(new RegExp(`\\b${n}\\b`));
  });

  it("still reports the Blob count when Neon fails, marked db=0", async () => {
    dbState.fail = true;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cloud.db).toBe(false);
    expect(body.cloud.noUsableCredential).toBe(3);
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});
