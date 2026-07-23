// @ts-check
// lib/rate-limit.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-IP, per-route rate limiting (audit #25). Fixed one-minute windows in
// instance memory. HONEST SCOPE: on serverless each warm instance keeps its
// own counters, so this is burst protection against a single client hammering
// one instance — enumeration/cost abuse throttling, not a distributed quota.
// That matches the threat model (#25 was "low priority — no sensitive data";
// reads are deliberately open per #20/#21). If we ever need a real
// distributed limiter, the Neon DB is the obvious backing store — that's a
// design conversation, not a default.
//
// Fail-open by design: a missing IP header buckets under "unknown" rather
// than blocking, and the cron route (Bearer-gated) is exempt entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const MAX_KEYS = 5_000; // memory backstop; expired keys sweep on overflow

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

export function clientIp(request) {
  return (
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/**
 * Returns null when the request is within budget, or a ready-to-return 429
 * NextResponse when it isn't. Call at the top of a route handler:
 *   const limited = rateLimit(request, "sync", 120); if (limited) return limited;
 * @param {Request} request
 * @param {string} route   logical bucket name, not the literal path
 * @param {number} limit   requests per minute per IP
 */
export function rateLimit(request, route, limit) {
  const now = Date.now();
  const key = `${route}:${clientIp(request)}`;
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;

  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }

  if (b.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  return null;
}

// Test hook — deterministic state between cases.
export function _resetRateLimiter() {
  buckets.clear();
}
