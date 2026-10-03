// tests/qr.test.js
// The invite QR encoder: published table values, reference matrices from an
// independent encoder, the symbol's fixed structure, mask choice, and a
// round trip through a small reader written here from the ISO tables.
import { describe, it, expect } from "vitest";
import {
  encodeQr, qrToSvgPath, rsEncode, formatBits, versionBits, penalty, byteCapacity, versionFor,
} from "@/lib/qr";

// Reference matrices: segno 1.6.6 (Python), make_qr(text, error="m",
// mode="byte", version=V, mask=K, boost_error=False), rows top to bottom,
// 1 = dark. segno appends a whole zero byte when the bit stream already ends
// on a byte boundary (ISO 7.4.10 pads only to the boundary), so the two
// non-full vectors were made with that one step corrected; the v7 vector
// fills the symbol and needed no correction. All three also decode with
// ZXing-C++ 3.1.1.
const SHARE = "https://heatwayve.app/share#ABCD0FGH1KMN";
const V7_TEXT = "https://heatwayve.app/share#ABCD0FGH1KMN?" + "0123456789".repeat(8) + "x";

const V7_ROWS = [
  "111111100010101101000100000001110100101111111",
  "100000100101101110011011111111000001001000001",
  "101110101100101010110100100010111101001011101",
  "101110101000001010100010000101000101101011101",
  "101110101000000001011111100100100011101011101",
  "100000101100011110001000111111010000001000001",
  "111111101010101010101010101010101010101111111",
  "000000001010010111111000100011111110000000000",
  "101111100100001101111111100000100101001111100",
  "100000010010011011000001010000111000100011111",
  "010101100110010100111100111101000110111100110",
  "101100000100011011100100101011111010001010100",
  "011100101010101111100011110101100110100101001",
  "100110010010101100101001000000101101100000111",
  "100111100010111110011000111111000011111001100",
  "010100010110110100100101000010001111010010110",
  "010111101010001000111010100101110000010101000",
  "000001001010010111010101000101111101100100111",
  "001110100010111010011000111111010011011000000",
  "110010011011000001100000000011111101010100100",
  "001011111101101100101111110100100101111111000",
  "000010001101101011011000100010111101100011100",
  "000110101100010000011010111001000010101010110",
  "011110001010000010101000100111111000100011111",
  "010011111001000110101111100001100000111111000",
  "001111001101000010110010100110101000101000101",
  "111110110010011010001000001011000111000010110",
  "111100011010011110001101100011111011111001101",
  "010011101010000001101101000100000010001010101",
  "101011011101101001010010100100110101001000111",
  "101010101001001111001001011111000010100100000",
  "010000000001101110011000100011111100001100100",
  "101111101100101000001101010100010100000011000",
  "010000011011111000010010100011100101110100111",
  "000010101100001010000001011000010011110101000",
  "011110000001101001011110100011111101100000110",
  "100110111001101010001111101101100000111111001",
  "000000001011001001011000100110101101100011100",
  "111111100011110100111010111001000011101010110",
  "100000101101001110001000111111111101100011101",
  "101110101000010010001111111100000001111111000",
  "101110101101111001010100010000110001010011111",
  "101110101100000011010010111001000010101100010",
  "100000100001111001101101000011111101000011100",
  "111111101111001111010110110101000101111100110",
];

const HELLO_ROWS = [
  "111111101000101111111",
  "100000101000101000001",
  "101110100000001011101",
  "101110101010101011101",
  "101110100111001011101",
  "100000100011101000001",
  "111111101010101111111",
  "000000001111100000000",
  "101101110101101001011",
  "011000010111111101100",
  "000001111101010100011",
  "101011011001000101010",
  "100010110110110000101",
  "000000001011001100101",
  "111111101011111110000",
  "100000101110010101111",
  "101110100100101001000",
  "101110101110001001110",
  "101110101100100100100",
  "100000100111011110001",
  "111111101101010100000",
];

const SHARE_ROWS = [
  "11111110111010100001101111111",
  "10000010100010100000001000001",
  "10111010001011101010101011101",
  "10111010111010100101001011101",
  "10111010010101101001101011101",
  "10000010000100000001001000001",
  "11111110101010101010101111111",
  "00000000101010011100100000000",
  "10110111010001101111101001011",
  "01101000110101011011101110001",
  "01100111001000000100110100110",
  "10001101100101110011010100001",
  "11110111110110110100100101100",
  "01000101101101101111001000111",
  "00101111110110101101101100111",
  "00011100011000010010000010010",
  "11111011010000101010110111010",
  "01010101100010011000110101110",
  "10011111101101110000011110100",
  "00010000100111101111010000100",
  "01000110010111101100111111100",
  "00000000111000011010100011111",
  "11111110110100101001101011010",
  "10000010110011111011100011001",
  "10111010000110010000111110111",
  "10111010111101001101110111001",
  "10111010110011101000010100101",
  "10000010010011100000100011010",
  "11111110110001100111101110010",
];

const rowsOf = ({ size, modules }) =>
  Array.from({ length: size }, (_, r) => Array.from(modules.slice(r * size, (r + 1) * size)).join(""));

// ISO/IEC 18004 table 9, level M: [EC per block, [blocks, data codewords]...].
const ISO_M = {
  1: [10, [1, 16]], 2: [16, [1, 28]], 3: [26, [1, 44]], 4: [18, [2, 32]], 5: [24, [2, 43]],
  6: [16, [4, 27]], 7: [18, [4, 31]], 8: [22, [2, 38], [2, 39]], 9: [22, [3, 36], [2, 37]], 10: [26, [4, 43], [1, 44]],
};
// Annex E alignment centres.
const ISO_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
// Byte-mode capacity at M, ISO table 7.
const ISO_BYTES_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

// GF(256) exponent table, built here so the generator check doesn't lean on the lib's.
const EXP = [];
for (let i = 0, x = 1; i < 255; i++) { EXP.push(x); x <<= 1; if (x & 0x100) x ^= 0x11d; }

/** Polynomial remainder over GF(2). */
function mod2(value, gen) {
  const deg = (n) => 31 - Math.clz32(n);
  let r = value;
  while (r && deg(r) >= deg(gen)) r ^= gen << (deg(r) - deg(gen));
  return r;
}

/** Where every function-pattern module sits, from the spec (not the lib). */
function functionMap(version) {
  const n = 17 + 4 * version;
  const f = new Uint8Array(n * n);
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < n && c < n) f[r * n + c] = 1; };
  // Finder + separator + format area: 9x9 top-left, 9x8 top-right, 8x9 bottom-left.
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) { mark(r, c); if (c < 8) mark(r, n - 1 - c); if (r < 8) mark(n - 1 - r, c); }
  for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
  const a = ISO_ALIGN[version];
  for (const r of a) for (const c of a) {
    if ((r === 6 && c === 6) || (r === 6 && c === a[a.length - 1]) || (r === a[a.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, n - 11 + j); mark(n - 11 + j, i); }
  return f;
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Format bits as written beside the top-left finder (copy 1), bit 14 first. */
function readFormat({ size, modules }) {
  const at = (r, c) => modules[r * size + c];
  const seq = [];
  for (let c = 0; c <= 8; c++) if (c !== 6) seq.push(at(8, c));
  for (let r = 7; r >= 0; r--) if (r !== 6) seq.push(at(r, 8));
  return parseInt(seq.join(""), 2);
}
/** Copy 2: bottom-left column then top-right row. */
function readFormat2({ size, modules }) {
  const at = (r, c) => modules[r * size + c];
  const seq = [];
  for (let r = size - 1; r >= size - 7; r--) seq.push(at(r, 8));
  for (let c = size - 8; c < size; c++) seq.push(at(8, c));
  return parseInt(seq.join(""), 2);
}

/** A small reader: unmask, walk the zigzag, de-interleave, check EC, parse byte mode. */
function readBack(q) {
  const { size, modules } = q;
  const version = (size - 17) / 4;
  const mask = (readFormat(q) ^ 0x5412) >> 10 & 7;
  const fmap = functionMap(version);
  const bits = [];
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    const up = ((size - 1 - right) / 2 | 0) % 2 === 0;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (fmap[r * size + c]) continue;
        bits.push(modules[r * size + c] ^ (MASK_FNS[mask](r, c) ? 1 : 0));
      }
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const [ec, ...groups] = ISO_M[version];
  const lens = groups.flatMap(([n, len]) => Array(n).fill(len));
  const blocks = lens.map(() => []);
  let i = 0;
  for (let k = 0; k < Math.max(...lens); k++) lens.forEach((len, b) => { if (k < len) blocks[b].push(words[i++]); });
  const ecBlocks = lens.map(() => []);
  for (let k = 0; k < ec; k++) ecBlocks.forEach((e) => e.push(words[i++]));
  blocks.forEach((b, j) => expect(rsEncode(b, ec)).toEqual(ecBlocks[j]));
  const data = blocks.flat().flatMap((w) => w.toString(2).padStart(8, "0").split("").map(Number));
  const take = (n) => parseInt(data.splice(0, n).join(""), 2);
  expect(take(4)).toBe(0b0100);
  const count = take(version < 10 ? 8 : 16);
  const out = new Uint8Array(count);
  for (let j = 0; j < count; j++) out[j] = take(8);
  return { mask, version, text: new TextDecoder().decode(out) };
}

describe("Reed-Solomon", () => {
  it("matches the published HELLO WORLD 1-M EC codewords", () => {
    // thonky.com QR tutorial, "Error Correction Coding" (alphanumeric data codewords).
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("uses the standard generator polynomials (ISO annex A, as alpha exponents)", () => {
    // x^n mod g(x) is g's lower coefficients, so encoding the single codeword 1 exposes them.
    const g7 = [87, 229, 146, 149, 238, 102, 21].map((e) => EXP[e]);
    const g10 = [251, 67, 46, 61, 118, 70, 64, 94, 32, 45].map((e) => EXP[e]);
    expect(rsEncode([1], 7)).toEqual(g7);
    expect(rsEncode([1], 10)).toEqual(g10);
  });
});

describe("format and version information", () => {
  it("level M format bits match the ISO table for every mask and pass the BCH check", () => {
    const table = ["101010000010010", "101000100100101", "101111001111100", "101101101001011",
      "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
    for (let m = 0; m < 8; m++) {
      expect(formatBits(m).toString(2).padStart(15, "0")).toBe(table[m]);
      expect(mod2(formatBits(m) ^ 0x5412, 0x537)).toBe(0);
      expect((formatBits(m) ^ 0x5412) >> 10).toBe(m); // level M is 00
    }
  });

  it("version bits match the ISO table for v7-v10 and pass the BCH check", () => {
    const table = { 7: "000111110010010100", 8: "001000010110111100", 9: "001001101010011001", 10: "001010010011010011" };
    for (const v of [7, 8, 9, 10]) {
      expect(versionBits(v).toString(2).padStart(18, "0")).toBe(table[v]);
      expect(mod2(versionBits(v), 0x1f25)).toBe(0);
    }
  });

  it("both format copies and both version blocks are written into the symbol", () => {
    for (let m = 0; m < 8; m++) {
      const q = encodeQr(V7_TEXT, { mask: m });
      expect(readFormat(q)).toBe(formatBits(m));
      expect(readFormat2(q)).toBe(formatBits(m));
      const { size, modules } = q;
      for (let i = 0; i < 18; i++) {
        const bit = (versionBits(7) >> i) & 1;
        expect(modules[Math.floor(i / 3) * size + size - 11 + (i % 3)]).toBe(bit);
        expect(modules[(size - 11 + (i % 3)) * size + Math.floor(i / 3)]).toBe(bit);
      }
    }
  });
});

describe("known-answer matrices", () => {
  it("HELLO WORLD: version 1, mask 3", () => {
    const q = encodeQr("HELLO WORLD");
    expect([q.version, q.mask, q.size]).toEqual([1, 3, 21]);
    expect(rowsOf(q)).toEqual(HELLO_ROWS);
  });

  it("the share link: 40 bytes, version 3, mask 3", () => {
    const q = encodeQr(SHARE);
    expect([q.version, q.mask, q.size]).toEqual([3, 3, 29]);
    expect(rowsOf(q)).toEqual(SHARE_ROWS);
  });

  it("a full version 7 symbol (122 bytes) with version information", () => {
    expect(new TextEncoder().encode(V7_TEXT).length).toBe(122);
    const q = encodeQr(V7_TEXT);
    expect([q.version, q.mask, q.size]).toEqual([7, 2, 45]);
    expect(rowsOf(q)).toEqual(V7_ROWS);
  });
});

describe("structure, versions 1-10", () => {
  const FINDER = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  for (let v = 1; v <= 10; v++) {
    it(`v${v}: size, finders, separators, timing, alignment, dark module`, () => {
      const q = encodeQr("y".repeat(ISO_BYTES_M[v - 1]));
      const { size, modules } = q;
      const at = (r, c) => modules[r * size + c];
      expect(q.version).toBe(v);
      expect(size).toBe(17 + 4 * v);
      expect(modules.length).toBe(size * size);
      for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = 0; r < 7; r++) {
          expect(Array.from({ length: 7 }, (_, c) => at(r0 + r, c0 + c)).join("")).toBe(FINDER[r]);
        }
      }
      for (let i = 0; i < 8; i++) {
        expect([at(7, i), at(i, 7), at(7, size - 1 - i), at(i, size - 8), at(size - 8, i), at(size - 1 - i, 7)]).toEqual([0, 0, 0, 0, 0, 0]);
      }
      for (let i = 8; i <= size - 9; i++) {
        expect(at(6, i)).toBe(i % 2 === 0 ? 1 : 0);
        expect(at(i, 6)).toBe(i % 2 === 0 ? 1 : 0);
      }
      expect(at(size - 8, 8)).toBe(1);
      const a = ISO_ALIGN[v];
      for (const r of a) for (const c of a) {
        if ((r === 6 && c === 6) || (r === 6 && c === a[a.length - 1]) || (r === a[a.length - 1] && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          expect(at(r + dr, c + dc)).toBe(Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
        }
      }
    });
  }
});

describe("capacity and version choice", () => {
  it("byte capacities at level M match ISO table 7", () => {
    expect(Array.from({ length: 10 }, (_, i) => byteCapacity(i + 1))).toEqual(ISO_BYTES_M);
  });

  it("every version round-trips at its capacity bound and steps up one byte past it", () => {
    for (let v = 1; v <= 10; v++) {
      const cap = ISO_BYTES_M[v - 1];
      const full = Array.from({ length: cap }, (_, i) => String.fromCharCode(33 + ((i * 7 + v) % 90))).join("");
      expect(versionFor(cap)).toBe(v);
      const back = readBack(encodeQr(full));
      expect(back).toMatchObject({ version: v, text: full });
      if (v < 10) expect(encodeQr(full + "!").version).toBe(v + 1);
    }
    expect(() => encodeQr("z".repeat(214))).toThrow(RangeError);
  });

  it("the spec's v3 bound: 42 bytes stay in v3, 43 move up", () => {
    expect(encodeQr("q".repeat(42)).version).toBe(3);
    expect(encodeQr("q".repeat(43)).version).toBe(4);
  });

  it("counts UTF-8 bytes, not characters, and reads them back", () => {
    const text = "é".repeat(7); // 14 bytes: the v1 bound
    expect(encodeQr(text).version).toBe(1);
    expect(encodeQr(text + "é").version).toBe(2);
    expect(readBack(encodeQr("Sam's trainer ✓")).text).toBe("Sam's trainer ✓");
  });

  it("round-trips the share link and the short vectors", () => {
    for (const t of [SHARE, "HELLO WORLD", V7_TEXT, ""]) expect(readBack(encodeQr(t)).text).toBe(t);
  });
});

describe("mask choice", () => {
  it("picks the lowest-penalty mask, the first on a tie", () => {
    for (const t of [SHARE, "HELLO WORLD", V7_TEXT, "a", "x".repeat(100), "https://heatwayve.app/share#ZZZZ9999ZZZZ"]) {
      const scores = Array.from({ length: 8 }, (_, k) => {
        const q = encodeQr(t, { mask: k });
        return penalty(q.modules, q.size);
      });
      expect(encodeQr(t).mask).toBe(scores.indexOf(Math.min(...scores)));
    }
  });

  it("scores the four penalty rules on hand-built matrices", () => {
    // 5x5 all dark: N1 10 runs of 5 (3 each) = 30, N2 16 blocks = 48, N3 0, N4 100% dark = 100.
    expect(penalty(new Uint8Array(25).fill(1), 5)).toBe(178);
    // 5x5 checkerboard: no runs, no blocks, 13/25 dark is within 5% of half.
    expect(penalty(Uint8Array.from({ length: 25 }, (_, i) => (i + 1) % 2), 5)).toBe(0);
    // 11x11 light with row 0 = 1011101 0000: N1 90 + 94, N2 270 + 9, N3 40 (once), N4 5/121 dark = 90.
    const m = new Uint8Array(121);
    [1, 0, 1, 1, 1, 0, 1].forEach((b, i) => { m[i] = b; });
    expect(penalty(m, 11)).toBe(593);
  });
});

describe("qrToSvgPath", () => {
  it("draws one unit square per dark module", () => {
    expect(qrToSvgPath(Uint8Array.from([1, 0, 0, 1]), 2)).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
    const q = encodeQr(SHARE);
    const d = qrToSvgPath(q.modules, q.size);
    const dark = q.modules.reduce((n, b) => n + b, 0);
    expect(d.match(/M/g).length).toBe(dark);
    expect(d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });
});
