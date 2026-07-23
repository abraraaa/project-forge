// tests/rate-limit.test.js
// ─────────────────────────────────────────────────────────────────────────────
// #25 locks: the limiter's window mechanics, and a class lock that every
// public API route calls rateLimit (cron is exempt — Bearer-gated).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { rateLimit, clientIp, _resetRateLimiter } from "../lib/rate-limit.js";

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
