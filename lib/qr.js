// @ts-check
// lib/qr.js
// ─────────────────────────────────────────────────────────────────────────────
// A small QR encoder for the trainer's invite sheet: byte mode, error
// correction level M, versions 1-10 (up to 213 bytes). Pure and client-safe.
// Tables and rules follow ISO/IEC 18004:2015 (block structure table 9,
// alignment positions annex E, format/version BCH codes sections 7.9-7.10,
// mask penalties section 7.8.3).
// ─────────────────────────────────────────────────────────────────────────────

// Level M block structure per version: [EC codewords per block, [blocks, data codewords]...].
/** @type {Array<[number, ...Array<[number, number]>]>} */
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const MAX_VERSION = 10;

/** Data codewords for a version at level M. @param {number} version */
export function dataCodewords(version) {
  const [, ...groups] = BLOCKS_M[version];
  return groups.reduce((n, [blocks, data]) => n + blocks * data, 0);
}

/** Byte-mode capacity at level M: 4 mode bits plus an 8-bit count (16 from v10). @param {number} version */
export function byteCapacity(version) {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

/** @param {number} a @param {number} b */
function gfMul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

/** Generator (x - a^0)(x - a^1)...(x - a^(n-1)), highest degree first, leading 1 dropped. @param {number} n */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g.slice(1);
}

/** Reed-Solomon EC codewords: the remainder of data * x^n divided by the generator. @param {ArrayLike<number>} data @param {number} n */
export function rsEncode(data, n) {
  const gen = generator(n);
  const rem = new Array(n).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= gfMul(gen[j], factor);
  }
  return rem;
}

/** 15 format bits for level M (bits 00) and a mask, BCH(15,5) then XOR 0x5412. @param {number} mask */
export function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits, BCH(18,6). @param {number} version */
export function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The smallest version whose level-M byte capacity holds n bytes, or 0 if none up to v10. @param {number} n */
export function versionFor(n) {
  for (let v = 1; v <= MAX_VERSION; v++) if (n <= byteCapacity(v)) return v;
  return 0;
}

/** Bit stream -> padded data codewords. @param {Uint8Array} bytes @param {number} version */
function dataStream(bytes, version) {
  const total = dataCodewords(version);
  /** @type {number[]} */
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  for (let pad = 0xec; out.length < total; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add EC, interleave. @param {number[]} data @param {number} version */
function codewords(data, version) {
  const [ec, ...groups] = BLOCKS_M[version];
  /** @type {number[][]} */
  const blocks = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + len)); at += len; }
  }
  const ecBlocks = blocks.map((b) => rsEncode(b, ec));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/** Function patterns with no mask and no format bits yet; `reserved` marks every non-data module. @param {number} version */
function skeleton(version) {
  const size = 17 + 4 * version;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const set = (r, c, dark) => { modules[r * size + c] = dark ? 1 : 0; reserved[r * size + c] = 1; };

  // Finders with their light separators.
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r, cc = fc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, ring !== 2 && ring !== 4);
      }
    }
  }
  // Timing.
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Alignment, skipping the three finder corners.
  const pos = ALIGNMENT[version];
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const r = pos[i], c = pos[j];
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // Format areas (filled per mask later) and the dark module.
  for (let i = 0; i < 9; i++) { reserved[8 * size + i] = 1; reserved[i * size + 8] = 1; }
  for (let i = 0; i < 8; i++) { reserved[8 * size + size - 1 - i] = 1; reserved[(size - 1 - i) * size + 8] = 1; }
  set(size - 8, 8, true);
  // Version blocks from v7.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = (bits >>> i) & 1;
      const a = Math.floor(i / 3), b = size - 11 + (i % 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, modules, reserved };
}

/** Zigzag placement of the codeword bits into every unreserved module. */
function place(modules, reserved, size, words) {
  let bit = 0;
  const total = words.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((size - 1 - right) >> 1) % 2 === 0;
    for (let k = 0; k < size; k++) {
      const r = upward ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        const i = r * size + c;
        if (reserved[i]) continue;
        modules[i] = bit < total ? (words[bit >> 3] >>> (7 - (bit & 7))) & 1 : 0;
        bit++;
      }
    }
  }
}

/** Write the 15 format bits in both copies. */
function writeFormat(modules, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = (bits >>> i) & 1;
    // Copy 1, around the top-left finder.
    if (i < 6) modules[i * size + 8] = dark;
    else if (i < 8) modules[(i + 1) * size + 8] = dark;
    else if (i === 8) modules[8 * size + 7] = dark;
    else modules[8 * size + 14 - i] = dark;
    // Copy 2, split between bottom-left and top-right.
    if (i < 8) modules[8 * size + size - 1 - i] = dark;
    else modules[(size - 15 + i) * size + 8] = dark;
  }
}

/** ISO 18004 penalty score N1 + N2 + N3 + N4, taken on the finished symbol (format bits in). @param {Uint8Array} m @param {number} size */
export function penalty(m, size) {
  let score = 0;
  const at = (r, c) => m[r * size + c];
  // N1 runs of five or more, rows then columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        const same = b < size && (pass ? at(b, a) === at(b - 1, a) : at(a, b) === at(a, b - 1));
        if (same) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
    }
  }
  // N2 2x2 blocks.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  // N3 finder-like 1011101 with four light modules on either side; past the
  // edge counts as light (the quiet zone), as ZXing and segno score it.
  const F = [1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    const get = (a, b) => (b < 0 || b >= size ? 0 : pass ? at(b, a) : at(a, b));
    const light = (a, from, to) => { for (let b = from; b < to; b++) if (get(a, b)) return false; return true; };
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        let hit = true;
        for (let k = 0; k < 7 && hit; k++) if (get(a, b + k) !== F[k]) hit = false;
        if (hit && (light(a, b - 4, b) || light(a, b + 7, b + 11))) score += 40;
      }
    }
  }
  // N4 dark share, 10 per full 5% step away from 50%.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  score += 10 * Math.floor(Math.abs(dark * 100 / m.length - 50) / 5);
  return score;
}

/**
 * Encode text (UTF-8, byte mode, level M) as a QR matrix. The version is the
 * smallest that fits; the mask is the one with the lowest penalty unless
 * `opts.mask` fixes it.
 * @param {string} text
 * @param {{ mask?: number }} [opts]
 * @returns {{ version: number, mask: number, size: number, modules: Uint8Array }}
 */
export function encodeQr(text, opts = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = versionFor(bytes.length);
  if (!version) throw new RangeError(`QR: ${bytes.length} bytes is over the ${byteCapacity(MAX_VERSION)}-byte limit`);
  const words = codewords(dataStream(bytes, version), version);
  const { size, modules: base, reserved } = skeleton(version);
  place(base, reserved, size, words);

  let best = null;
  const masks = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  for (const mask of masks) {
    const m = base.slice();
    const fn = MASKS[mask];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (!reserved[r * size + c] && fn(r, c)) m[r * size + c] ^= 1;
    }
    writeFormat(m, size, mask);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { score, mask, modules: m };
  }
  return { version, mask: best.mask, size, modules: best.modules };
}

/**
 * One path "d" of unit squares, one "M" per dark module, in module coordinates.
 * @param {Uint8Array} modules @param {number} size
 */
export function qrToSvgPath(modules, size) {
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (modules[r * size + c]) d += `M${c} ${r}h1v1h-1z`;
  }
  return d;
}
