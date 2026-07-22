// @ts-check
// lib/net.js
// ─────────────────────────────────────────────────────────────────────────────
// fetch with a deadline (audit #40). iOS radio-limbo — a dying cellular link
// that neither delivers nor errors — can hold a plain fetch open for minutes,
// which hangs anything awaiting it (the restore splash being the painful
// case). Every client → API call goes through here so no request can outlive
// its usefulness; callers keep their existing catch paths, a timeout just
// arrives as an AbortError like any other network failure.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 15000;
// Photo uploads push ~400–800KB (3MB ceiling) up a possibly-slow uplink —
// give them room before declaring limbo.
export const UPLOAD_TIMEOUT_MS = 45000;

/**
 * Drop-in fetch wrapper that aborts after `timeoutMs`.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
