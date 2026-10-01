// Identity equivalence: the storage-key path builders yield, byte for byte,
// the paths the routes built inline before lib/storage-keys existed.
// (Path half. The route half lands with the identity cutover commits.)

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";
import { normaliseProfile } from "../lib/profile-name.js";
import {
  profileDir, metaPath, historyPath, credentialsPrefix, credentialsPath,
  photosPrefix, photoPath, snapshotPaths,
} from "../lib/storage-keys.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(resolve(root, f), "utf8");

// The pre-storage-keys formulas, copied from the routes and frozen. Each took
// the raw name and normalised it inline.
const normalise = normaliseProfile;
const OLD = {
  // sync:37-41, register-options:17
  meta: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`,
  history: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`,
  prefix: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/`,
  // register-verify, login-options, login-verify, check, sync DELETE, oauth-credentials
  credPrefix: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`,
  credPath: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`,
  // photos:46-47, called with the gate's already-normalised profile
  photo: (profile, date) => `forge/profiles/${encodeURIComponent(normalise(profile))}/photos/${date}.jpg`,
  // passkey-census bucket prefix (n is the decoded key)
  photosPrefix: (n) => `forge/profiles/${encodeURIComponent(n)}/photos/`,
  // sync DELETE: enc = encodeURIComponent(normalise(profile))
  wipeDaily: (name) => `forge/snapshots/daily/${encodeURIComponent(normalise(name))}.json`,
  wipeWeekly: (name) => `forge/snapshots/weekly/${encodeURIComponent(normalise(name))}.json`,
  // snapshot cron: the DB key, not re-normalised
  cronDaily: (profile) => `forge/snapshots/daily/${encodeURIComponent(profile)}.json`,
  cronWeekly: (profile) => `forge/snapshots/weekly/${encodeURIComponent(profile)}.json`,
  // login/register options + verify (fallback challenge blob)
  challenge: (name) => `forge/challenges/${createHash("sha256").update(normalise(name)).digest("base64url")}`,
};

const NAMES = [
  "sam", "Sam ", "ＳＡＭ", "café", "café", "a b", "x%y", "o'neil",
  "Kelvin", "Kelvin", "Ünïcödé 名前", "émoji 💪", "  padded  ",
];
const DATE = "2026-10-01";

describe("storage-key builders equal the old inline formulas", () => {
  for (const n of NAMES) {
    // Existing accounts: storage key = today's normalised handle.
    const sk = normaliseProfile(n);
    it(JSON.stringify(n), () => {
      expect(metaPath(sk)).toBe(OLD.meta(n));
      expect(historyPath(sk)).toBe(OLD.history(n));
      expect(profileDir(sk)).toBe(OLD.prefix(n));
      expect(profileDir(sk).endsWith("/")).toBe(true);
      expect(credentialsPrefix(sk)).toBe(OLD.credPrefix(n));
      expect(credentialsPath(sk)).toBe(OLD.credPath(n));
      // photos route: g.profile = normalise(name); the old builder normalised again.
      const g = normalise(n);
      expect(photoPath(normalise(g), DATE)).toBe(OLD.photo(g, DATE));
      expect(photoPath(sk, DATE)).toBe(OLD.photo(n, DATE));
      expect(photosPrefix(sk)).toBe(OLD.photosPrefix(sk));
      const wipe = snapshotPaths(normalise(n));
      expect(wipe.daily).toBe(OLD.wipeDaily(n));
      expect(wipe.weekly).toBe(OLD.wipeWeekly(n));
      const cron = snapshotPaths(sk);
      expect(cron.daily).toBe(OLD.cronDaily(sk));
      expect(cron.weekly).toBe(OLD.cronWeekly(sk));
    });
  }

  it("builders take the key verbatim and never normalise again", () => {
    expect(metaPath("Sam ")).toBe("forge/profiles/Sam%20/meta.json");
    expect(snapshotPaths("ＳＡＭ").daily).toBe(`forge/snapshots/daily/${encodeURIComponent("ＳＡＭ")}.json`);
    expect(profileDir("hwa_abc")).toBe("forge/profiles/hwa_abc/");
  });

  it("look-alike names land on one key, as before", () => {
    expect(metaPath(normaliseProfile("ＳＡＭ"))).toBe("forge/profiles/sam/meta.json");
    expect(metaPath(normaliseProfile("Kelvin"))).toBe(metaPath(normaliseProfile("kelvin")));
    expect(metaPath(normaliseProfile("café"))).toBe(metaPath(normaliseProfile("café")));
  });
});

describe("the challenge key is unchanged", () => {
  const ROUTES = [
    "app/api/auth/login-options/route.js", "app/api/auth/login-verify/route.js",
    "app/api/auth/register-options/route.js", "app/api/auth/register-verify/route.js",
  ];
  it("every ceremony route still derives it from sha256(normalise(profile))", () => {
    for (const f of ROUTES) {
      const src = read(f);
      expect(src).toContain('crypto.createHash("sha256").update(normalise(profile)).digest("base64url")');
      expect(src).toContain("forge/challenges/${userId}");
    }
    expect(OLD.challenge("ＳＡＭ")).toBe(OLD.challenge("sam"));
  });
});

describe("lib/storage-keys is the only builder of storage-key paths", () => {
  const walk = (d) => readdirSync(resolve(root, d)).flatMap((e) => {
    const p = join(d, e);
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : /\.(js|jsx|ts)$/.test(e) ? [p] : [];
  });
  // db-import reads a dir segment it LISTED (already encoded), not a key.
  const ALLOWED = ["lib/storage-keys.js", "app/api/diag/db-import/route.js"];
  it("no other file interpolates into a profile or snapshot path", () => {
    const offenders = [...walk("app"), ...walk("lib")]
      .map((f) => relative(root, resolve(root, f)))
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => /forge\/(profiles|snapshots\/(daily|weekly))\/\$\{/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
