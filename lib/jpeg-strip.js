// @ts-check
// lib/jpeg-strip.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side metadata strip for uploaded JPEGs. The client's canvas re-encode
// (lib/photos.js preparePhoto) already drops all metadata; this is the same
// promise kept for a request that never went through the client.
//
// Walks the segment table and drops whole segments; it never decodes or
// re-encodes, so everything kept is copied byte for byte.
//
// Kept: SOI, APP0 (JFIF/JFXX), APP14 (Adobe: decoders read its colour
// transform flag, so dropping it can change CMYK/YCCK colours), DQT, DHT,
// SOFn, DRI, DNL, DAC, SOS and its entropy-coded data, RSTn, EOI.
// Dropped: every other APPn and COM. That covers APP1 (Exif, GPS, XMP), APP13
// (IPTC/Photoshop) and the vendor blocks in APP3-APP12/APP15. APP2 goes too:
// it carries ICC profiles, whose header names the device maker and model, and
// MPF, which indexes secondary images appended after the first EOI. Losing the
// ICC profile matches what the client's canvas output already is (untagged,
// read as sRGB). Bytes after the first EOI are not part of the image (MPF
// thumbnails, each with its own Exif, live there) and are dropped as well.
//
// Dropping APP1 also drops the Exif orientation tag. The client bakes rotation
// into the pixels before encoding, so its output never relies on that tag.
//
// Malformed or truncated structure returns null: the caller refuses the upload.
// ─────────────────────────────────────────────────────────────────────────────

const APP0 = 0xe0;
const APP14 = 0xee;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;

/** @param {number} m */
const isDroppedMarker = (m) => m === COM || (m >= 0xe0 && m <= 0xef && m !== APP0 && m !== APP14);
/** @param {number} m */
const isRst = (m) => m >= 0xd0 && m <= 0xd7;

/**
 * Pure: the JPEG with its metadata segments removed, or null when the segment
 * table is malformed or the stream is truncated. Returns the input itself when
 * there is nothing to drop.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
export function stripJpegMetadata(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const n = bytes.length;
  /** @type {Array<[number, number]>} kept byte ranges, [start, end) */
  const keep = [[0, 2]];
  let dropped = false;
  let i = 2;
  for (;;) {
    // Every segment starts at a marker, optionally preceded by fill bytes.
    const start = i;
    if (i >= n || bytes[i] !== 0xff) return null;
    while (i < n && bytes[i] === 0xff) i += 1;
    if (i >= n) return null;
    const m = bytes[i];
    i += 1;
    if (m === 0x00 || m === 0xd8) return null; // stuffed byte or second SOI outside a scan
    if (m === EOI) {
      keep.push([start, i]);
      if (i < n) dropped = true; // trailing bytes after the image
      break;
    }
    if (isRst(m) || m === 0x01) { keep.push([start, i]); continue; } // standalone markers
    if (i + 2 > n) return null;
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2 || i + len > n) return null;
    i += len;
    if (m === SOS) {
      // Entropy-coded data runs to the next marker that is not a stuffed zero
      // or a restart marker.
      while (i < n) {
        if (bytes[i] !== 0xff) { i += 1; continue; }
        const next = i + 1 < n ? bytes[i + 1] : -1;
        if (next === 0x00 || isRst(next)) { i += 2; continue; }
        break;
      }
      if (i >= n) return null; // scan never ended
    }
    if (isDroppedMarker(m)) dropped = true;
    else keep.push([start, i]);
  }
  if (!dropped) return bytes;
  const out = new Uint8Array(keep.reduce((sum, [a, b]) => sum + (b - a), 0));
  let o = 0;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), o);
    o += b - a;
  }
  return out;
}
