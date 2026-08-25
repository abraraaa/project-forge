// Photos are keyed by profile name, so a re-claimed name would inherit them.
// Claiming a lapsed profile retires the rows (UPDATE, never DELETE). The
// trigger must stay false for every path that proved control.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isReclaimOfLapsedProfile } from "../lib/auth-server.js";
import { retiredPhotoKey } from "../lib/db.js";
import { NATIVE_RP_ID, acceptedRpIds } from "../lib/origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");
const at = (d) => new Date(`${d}T12:00:00`).getTime();
const OPEN = acceptedRpIds(at("2026-09-01"));   // window open
const AFTER = acceptedRpIds(at("2026-12-01"));  // legacy retired

const legacy = { id: "l", publicKey: "k" };
const native = { id: "n", publicKey: "k", rpId: NATIVE_RP_ID };

describe("the re-claim trigger — false whenever control was proved", () => {
  it("is FALSE for a first-ever claim: there is nothing to inherit", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [] }, OPEN)).toBe(false);
    expect(isReclaimOfLapsedProfile(null, OPEN)).toBe(false);
  });

  it("is FALSE when adding a second passkey to a live profile", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [native] }, OPEN)).toBe(false);
  });

  it("is FALSE during the rpId UPGRADE — the flow we just shipped", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [legacy] }, OPEN)).toBe(false);
  });

  it("is FALSE after the sunset for someone who already upgraded", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [legacy, native] }, AFTER)).toBe(false);
  });

  it("is TRUE only when a lapsed name is taken by someone who could not prove control", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [legacy] }, AFTER)).toBe(true);
  });

  it("is TRUE for a profile whose only credentials were always keyless", () => {
    expect(isReclaimOfLapsedProfile({ credentials: [{ id: "a" }] }, OPEN)).toBe(true);
  });
});

describe("retiring is a rename, and cannot collide with a real profile", () => {
  it("uses a separator no profile name may contain", () => {
    const key = retiredPhotoKey("sam", "2026-08-20T00:00:00.000Z");
    expect(key).toContain("/");
    expect(key.startsWith("sam/")).toBe(true);
  });

  it("keeps distinct retirements distinct", () => {
    expect(retiredPhotoKey("sam", "a")).not.toBe(retiredPhotoKey("sam", "b"));
  });

  it("a profile name cannot be spelled to impersonate a retired key", () => {
    // "/" is rejected by both name validators.
    const bad = src("app/api/photos/route.js");
    expect(bad).toContain('ch === "/"');
  });
});

describe("nothing is deleted to achieve refusal", () => {
  it("the retire helper is an UPDATE, never a DELETE", () => {
    const db = src("lib/db.js");
    const fn = db.slice(db.indexOf("export async function dbRetirePhotos"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("UPDATE photos SET profile");
    expect(body).not.toMatch(/\bDELETE\b/);
  });

  it("register-verify retires but never deletes photo data", () => {
    const s = src("app/api/auth/register-verify/route.js");
    expect(s).toContain("dbRetirePhotos");
    expect(s).not.toContain("dbDeletePhoto");
    expect(s).not.toContain("dbDeleteProfile");
  });

  it("retiring runs only under the trigger, and only after the credential write", () => {
    const s = src("app/api/auth/register-verify/route.js");
    expect(s).toContain("if (reclaim) {");
    // Decided before the write, acted on after it.
    const write = s.indexOf("await writeJsonReplacingPrefix(");   // the call, not the import
    expect(s.indexOf("const reclaim =")).toBeLessThan(write);
    expect(write).toBeLessThan(s.indexOf("await dbRetirePhotos("));
  });

  it("a failure to retire never fails the registration", () => {
    const s = src("app/api/auth/register-verify/route.js");
    const i = s.indexOf("dbRetirePhotos(");
    expect(s.slice(i, i + 200)).toMatch(/\} catch \{/);
  });
});

describe("the index is the authority, not the path formula", () => {
  it("GET resolves the blob through the stored row", () => {
    const s = src("app/api/photos/route.js");
    const get = s.slice(s.indexOf("export async function GET"), s.indexOf("export async function DELETE"));
    expect(get).toContain("dbGetPhoto(g.profile, g.date)");
    expect(get).toContain("get(row.blob_path");
    // A recomputed path is guessable a date at a time.
    expect(get).not.toContain("photoPath(g.profile, g.date)");
  });

  it("DELETE can only remove a blob this profile's own index points at", () => {
    const s = src("app/api/photos/route.js");
    const del = s.slice(s.indexOf("export async function DELETE"));
    expect(del).toContain("dbGetPhoto(g.profile, g.date)");
    expect(del).toContain("const path = row.blob_path");
    expect(del).not.toContain("photoPath(g.profile, g.date)");
  });

  it("the held-photos line offers a real way to reach a human", () => {
    // Recovery is manual, so the notice must keep a contact route.
    const s = src("app/locker-room/page.jsx");
    expect(s).toContain("Earlier photos from a previous sign-in");
    expect(s).toMatch(/mailto:[^"']+@[^"']+/);
  });

  it("the held-photos signal carries no count, dates or paths", () => {
    const s = src("app/api/photos/route.js");
    expect(s).toContain("heldPhotos: await dbHasRetiredPhotos(g.profile)");
    expect(s).not.toMatch(/heldPhotos:\s*(rows|\d|\[)/);
  });

  it("the retired-row probe cannot be widened by a name containing % or _", () => {
    // LIKE would treat % and _ in a name as wildcards.
    const db = src("lib/db.js");
    const fn = db.slice(db.indexOf("export async function dbHasRetiredPhotos"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("left(profile,");
    expect(body).not.toMatch(/\bLIKE\b/);
  });
});
