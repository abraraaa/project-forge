// tests/rate-limit.test.js
// ─────────────────────────────────────────────────────────────────────────────
// #25 locks: the limiter's window mechanics, and a class lock that every
// public API route calls rateLimit (cron is exempt — Bearer-gated).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { rateLimit, rateLimitShared, sharedBucket, clientIp, _resetRateLimiter } from "../lib/rate-limit.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const req = (ip = "1.2.3.4") =>
  new Request("https://theforged.fit/api/x", { headers: { "x-real-ip": ip } });

describe("rateLimit mechanics", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("allows up to the limit, 429s past it, with Retry-After", () => {
    for (let i = 0; i < 5; i++) expect(rateLimit(req(), "t", 5)).toBeNull();
    const limited = rateLimit(req(), "t", 5);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("windows reset after a minute", () => {
    for (let i = 0; i < 5; i++) rateLimit(req(), "t", 5);
    expect(rateLimit(req(), "t", 5)?.status).toBe(429);
    vi.advanceTimersByTime(61_000);
    expect(rateLimit(req(), "t", 5)).toBeNull();
  });

  it("buckets are per-IP and per-route", () => {
    for (let i = 0; i < 5; i++) rateLimit(req("1.1.1.1"), "t", 5);
    expect(rateLimit(req("2.2.2.2"), "t", 5)).toBeNull();   // other IP unaffected
    expect(rateLimit(req("1.1.1.1"), "other", 5)).toBeNull(); // other route unaffected
  });

  it("clientIp: x-real-ip, then first x-forwarded-for hop, then fail-open 'unknown'", () => {
    expect(clientIp(new Request("https://x/", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "7.7.7.7, 10.0.0.1" } }))).toBe("7.7.7.7");
    expect(clientIp(new Request("https://x/"))).toBe("unknown");
  });
});

describe("the existence oracle is on its own tight bucket", () => {
  it("check=1 uses a separate, much smaller bucket than authenticated reads", () => {
    // The signup availability probe is unauthenticated and pure-oracle; J1
    // made it near-worthless (existence grants no read/write/wipe) but the
    // point of a tight bucket is to make BULK enumeration expensive without
    // touching the one-name-at-a-time signup UX.
    const s = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
    expect(s).toContain('["sync-check", 10]');
    expect(s).toContain('["sync-read", 120]');
    // and the check path is the one that gets the small bucket
    expect(s).toMatch(/check \? \["sync-check", 10\] : \["sync-read", 120\]/);
  });
});

describe("coverage class lock — every public API route is limited", () => {
  it("each route.js under app/api (except cron) calls rateLimit in every exported verb", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const f of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        const rel = join(dir, f.name);
        if (f.isDirectory()) { walk(rel); continue; }
        if (f.name !== "route.js" || rel.includes("cron")) continue;
        const src = readFileSync(resolve(root, rel), "utf8");
        const verbs = (src.match(/export async function (GET|POST|PUT|PATCH|DELETE)/g) || []).length;
        const guards = (src.match(/rateLimit\(request,/g) || []).length;
        if (verbs !== guards) offenders.push(`${rel}: ${verbs} verbs, ${guards} guards`);
      }
    };
    walk("app/api");
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});

describe("rateLimitShared (Neon-backed, bounded)", () => {
  // Fake Neon tag: models the rate_buckets upsert, ignores schema DDL.
  const fakeDb = () => {
    const rows = new Map();
    const q = (strings, ...v) => {
      const text = strings.join("?");
      if (!text.includes("INSERT INTO rate_buckets")) return Promise.resolve([]);
      const [bucket, windowStart] = v;
      const r = rows.get(bucket);
      const count = r && r.window_start === windowStart ? r.count + 1 : 1;
      rows.set(bucket, { window_start: windowStart, count });
      return Promise.resolve([{ count }]);
    };
    return { q, rows };
  };
  const req = (ip) => ({ headers: new Headers({ "x-real-ip": ip }) });

  it("limits across calls sharing the store, then resets in place next window", async () => {
    const { q, rows } = fakeDb();
    const now = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) expect(await rateLimitShared(req("1.1.1.1"), "t", 3, { q, now })).toBeNull();
    const res = await rateLimitShared(req("1.1.1.1"), "t", 3, { q, now });
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await rateLimitShared(req("1.1.1.1"), "t", 3, { q, now: now + 60_000 })).toBeNull();
    expect(rows.size).toBe(1);
  });

  it("keys hash into a bounded bucket space per route", () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(sharedBucket("r", `ip-${i}`));
    expect(seen.size).toBeLessThanOrEqual(1024);
    expect(sharedBucket("r", "x")).toBe(sharedBucket("r", "x"));
  });

  it("fails open when the database errors or is absent", async () => {
    const q = () => Promise.reject(new Error("down"));
    expect(await rateLimitShared(req("2.2.2.2"), "t", 0, { q })).toBeNull();
    expect(await rateLimitShared(req("2.2.2.2"), "t", 0, { q: null })).toBeNull();
  });
});
