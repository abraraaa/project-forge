// @ts-check
// lib/entitlements.js
// ─────────────────────────────────────────────────────────────────────────────
// The single place an account's roles or plan are read. Everything else asks
// `entitled(account, key)`. A future paid capability is a RULES entry reading
// `a.plan` (default "free"); no route compares roles or plan directly.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, (a: { roles: string[], plan?: string }) => boolean>} */
const RULES = {
  // Trainer handles never lapse: no reclaim, no release, unless the account is explicitly deleted.
  "handle.neverLapse": (a) => a.roles.includes("trainer"),
};

export const DEFAULT_PLAN = "free";

/**
 * The only place a role or plan is read.
 * @param {{ roles?: unknown, plan?: string } | null | undefined} account
 * @param {string} key
 */
export function entitled(account, key) {
  const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : null;
  return !!(rule && account && Array.isArray(account.roles) && rule({ roles: account.roles, plan: account.plan ?? DEFAULT_PLAN }));
}
