// @ts-check
// lib/rate-limit.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-IP, per-route rate limiting (audit #25). Fixed one-minute windows in
// instance memory. HONEST SCOPE: on serverless each warm instance keeps its
// own counters, so this is burst protection against a single client hammering
// one instance — enumeration/cost abuse throttling, not a distributed quota.
// That matches the threat model (#25 was "low priority — no sensitive data";
// reads are deliberately open per #20/#21). Routes that guard sign-in,
// OAuth and /mcp also call rateLimitShared (below), which counts in Neon so
// the limit holds across instances.
//
// clientIp trusts x-real-ip / x-forwarded-for: Vercel overwrites both at the
// edge, so a client can't spoof them.
//
// Fail-open by design: a missing IP header buckets under "unknown" rather
// than blocking, and the cron route (Bearer-gated) is exempt entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { sql, ensureSchema } from "./db.js";

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
    return tooMany(b.resetAt - now);
  }
  return null;
}

const tooMany = (retryAfterMs) => NextResponse.json(
  { error: "Too many requests" },
  { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
);

// Keys hash into a fixed number of buckets per route, so the table's size is
// bounded by routes × SHARED_BUCKETS whatever the traffic. A collision only
// shares a count within one window.
const SHARED_BUCKETS = 1024;
export const sharedBucket = (route, id) =>
  `${route}:${parseInt(createHash("sha256").update(String(id)).digest("hex").slice(0, 8), 16) % SHARED_BUCKETS}`;

/**
 * Cross-instance limit, counted in Neon. One row per bucket, reset in place
 * when its window rolls over. Fails open if the database is unavailable (the
 * in-memory limiter still applies).
 * @param {Request | { headers: Headers }} request
 * @param {string} route
 * @param {number} limit   requests per window
 * @param {{ windowMs?: number, id?: string, now?: number, q?: any }} [opts]
 *   id defaults to the client IP; pass "all" for a route-wide cap.
 */
export async function rateLimitShared(request, route, limit, { windowMs = WINDOW_MS, id, now = Date.now(), q = sql() } = {}) {
  if (!q) return null;
  const bucket = sharedBucket(route, id ?? clientIp(request));
  const windowStart = Math.floor(now / windowMs) * windowMs;
  try {
    await ensureSchema(q);
    const rows = await q`INSERT INTO rate_buckets (bucket, window_start, count) VALUES (${bucket}, ${windowStart}, 1)
      ON CONFLICT (bucket) DO UPDATE SET
        count = CASE WHEN rate_buckets.window_start = EXCLUDED.window_start THEN rate_buckets.count + 1 ELSE 1 END,
        window_start = EXCLUDED.window_start
      RETURNING count`;
    if (Number(rows?.[0]?.count) > limit) return tooMany(windowStart + windowMs - now);
  } catch {
    // fail open
  }
  return null;
}

// Test hook — deterministic state between cases.
export function _resetRateLimiter() {
  buckets.clear();
}
