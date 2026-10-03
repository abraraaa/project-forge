// Trainer invite codes: 12 Crockford base32 characters (60 bits), forgiving
// to type and paste, never showing I, L, O or U.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crockford, normaliseCode, formatCode, shareUrl, CODE_ALPHABET, CODE_LENGTH } from "../lib/trainer-code.js";
import { newInviteCode, codeHash } from "../lib/trainer-store.js";
import { base32lower } from "../lib/identity.js";
import { hashSecret } from "../lib/oauth.js";

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const codes = Array.from({ length: 10_000 }, () => newInviteCode());

describe("newInviteCode", () => {
  it("10k codes: all 12 Crockford characters, every symbol seen, no I/L/O/U, no duplicates", () => {
    for (const c of codes) expect(c).toMatch(CODE_RE);
    const seen = new Set(codes.join(""));
    expect([...seen].sort().join("")).toBe(CODE_ALPHABET);
    expect(codes.join("")).not.toMatch(/[ILOU]/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("is the first 12 characters of 8 random bytes: 60 full bits, no padding character", () => {
    expect(CODE_LENGTH).toBe(12);
    // The 13th character of 8 bytes carries 4 bits plus a zero pad, so its
    // last bit is always 0; the 12 kept are uniform. Position 12 (last kept)
    // shows odd-index symbols as often as even ones.
    const odd = codes.filter((c) => CODE_ALPHABET.indexOf(c[11]) % 2 === 1).length;
    expect(odd).toBeGreaterThan(4500);
    expect(odd).toBeLessThan(5500);
  });
});

describe("crockford", () => {
  it("packs bits exactly as base32lower does, over the Crockford alphabet", () => {
    const RFC = "abcdefghijklmnopqrstuvwxyz234567";
    for (let i = 0; i < 500; i++) {
      const b = randomBytes(1 + (i % 17));
      const viaRfc = [...base32lower(b)].map((ch) => CODE_ALPHABET[RFC.indexOf(ch)]).join("");
      expect(crockford(b)).toBe(viaRfc);
    }
  });

  it("known vectors", () => {
    expect(crockford(new Uint8Array([]))).toBe("");
    expect(crockford(new Uint8Array([0, 0, 0, 0, 0]))).toBe("00000000");
    expect(crockford(new Uint8Array([255, 255, 255, 255, 255]))).toBe("ZZZZZZZZ");
    // 0x08 0x86 0x42 0x98 0xE8 = 00001 00010 00011 00100 00101 00110 00111 01000
    expect(crockford(new Uint8Array([0x08, 0x86, 0x42, 0x98, 0xe8]))).toBe("12345678");
  });

  it("is client-safe: no node:crypto, no server imports", () => {
    const src = readFileSync(resolve(__dirname, "../lib/trainer-code.js"), "utf8");
    expect(src).not.toMatch(/\bimport\b/);
  });
});

describe("normaliseCode", () => {
  const sample = codes.slice(0, 300);

  it("round-trips formatCode", () => {
    for (const c of sample) expect(normaliseCode(formatCode(c))).toBe(c);
  });

  it("forgives case, separators, a pasted link and O/I/L typed for 0/1/1", () => {
    for (const c of sample) {
      expect(normaliseCode(c.toLowerCase())).toBe(c);
      expect(normaliseCode(formatCode(c).toLowerCase())).toBe(c);
      expect(normaliseCode(formatCode(c).replace(/ /g, "-"))).toBe(c);
      expect(normaliseCode(`  ${c.slice(0, 4)} - ${c.slice(4, 8)}·${c.slice(8)}. `)).toBe(c);
      expect(normaliseCode(shareUrl(c))).toBe(c);
      expect(normaliseCode(shareUrl(formatCode(c).toLowerCase()))).toBe(c);
    }
    const c = "01AB0CD1EF1G";
    expect(normaliseCode("OIAB0CDLEFiG")).toBe(c);
    expect(normaliseCode("oiab ocdl efLg")).toBe(c);
  });

  it("reads full-width characters typed on an East Asian keyboard (NFKC)", () => {
    expect(normaliseCode("ＡＢＣＤ　ＥＦＧＨ　ＪＫＭＮ")).toBe("ABCDEFGHJKMN");
  });

  it("rejects U, wrong lengths, other symbols and non-strings", () => {
    const c = sample[0];
    expect(normaliseCode("ABCDEFGHJKMU")).toBeNull();
    expect(normaliseCode("abcdefghjkmu")).toBeNull();
    expect(normaliseCode(c.slice(0, 11))).toBeNull();
    expect(normaliseCode(c + "0")).toBeNull();
    expect(normaliseCode(c.slice(0, 11) + "!")).toBeNull();
    expect(normaliseCode(c.slice(0, 11) + "_")).toBeNull();
    expect(normaliseCode("https://heatwayve.app/share")).toBeNull();
    expect(normaliseCode("https://heatwayve.app/share#")).toBeNull();
    expect(normaliseCode("")).toBeNull();
    for (const x of [null, undefined, 123456789012, {}, [c]]) expect(normaliseCode(x)).toBeNull();
  });
});

describe("formatCode and shareUrl", () => {
  it("formatCode shows three groups of four", () => {
    expect(formatCode("ABCDEFGHJKMN")).toBe("ABCD EFGH JKMN");
  });

  it("shareUrl is the share page with the code in the fragment, 40 bytes", () => {
    const c = codes[0];
    expect(shareUrl(c)).toBe("https://heatwayve.app/share#" + c);
    expect(shareUrl(c).length).toBe(40);
    expect(new TextEncoder().encode(shareUrl(c)).length).toBe(40);
  });
});

describe("codeHash", () => {
  it("is SHA-256 hex of the canonical code, whatever form it was typed in", () => {
    const c = codes[1];
    const h = hashSecret(c);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const typed of [c, c.toLowerCase(), formatCode(c), shareUrl(c)]) expect(codeHash(typed)).toBe(h);
    expect(codeHash("not a code")).toBeNull();
  });
});
