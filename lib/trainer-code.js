// @ts-check
// lib/trainer-code.js
// ─────────────────────────────────────────────────────────────────────────────
// Trainer invite codes: 12 characters of Crockford base32 (60 bits). The
// alphabet has no I, L, O or U, so a shown code never holds a letter that
// reads as 0 or 1. Pure and client-safe (no node:crypto); the server mints
// and hashes codes in lib/trainer-store.js.
// ─────────────────────────────────────────────────────────────────────────────

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 12;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const SHARE_BASE = "https://heatwayve.app/share#";

/** Crockford base32, no padding: the bit packing of base32lower (lib/identity.js). @param {Uint8Array} bytes */
export function crockford(bytes) {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CODE_ALPHABET[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += CODE_ALPHABET[(buf << (5 - bits)) & 31];
  return out;
}

/**
 * A typed or pasted code in canonical form, or null. A pasted share link
 * keeps only what follows "#". Case, spaces and - · . separators are ignored,
 * and O, I and L read as 0, 1 and 1.
 * @param {unknown} s
 * @returns {string | null}
 */
export function normaliseCode(s) {
  if (typeof s !== "string") return null;
  const hash = s.indexOf("#");
  const c = (hash >= 0 ? s.slice(hash + 1) : s)
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s·.-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CODE_RE.test(c) ? c : null;
}

/** "ABCD EFGH JKMN": three groups of four, for display. @param {string} c */
export const formatCode = (c) => String(c ?? "").replace(/(.{4})(?=.)/g, "$1 ");

/** The share link. 40 bytes, inside a version 3-M QR's byte capacity. @param {string} c */
export const shareUrl = (c) => SHARE_BASE + c;
