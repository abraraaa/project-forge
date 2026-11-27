// Hand-built JPEG segments for the metadata-strip tests. Structure only: the
// entropy-coded bytes are not a decodable image, which the strip never needs.

/** One marker segment: FF, marker, 2-byte length (payload + 2), payload. */
export const seg = (marker, payload) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
};
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];
export const APP0_JFIF = seg(0xe0, [...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
export const DQT = seg(0xdb, [0x00, ...Array.from({ length: 64 }, (_, k) => (k % 30) + 1)]);
export const SOF0 = seg(0xc0, [0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00]); // 800x600, 1 component
export const DHT = seg(0xc4, [0x00, 0x00, 0x01, ...Array(14).fill(0x00), 0x00]);
export const SOS = seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
// Entropy-coded data with a stuffed FF00 (followed by E1, which must not read
// as an APP1 marker) and a restart marker inside the scan.
export const SCAN = [0x12, 0x34, 0xff, 0x00, 0xe1, 0x56, 0xff, 0xd0, 0x78, 0xff, 0x00, 0x9a];
export const APP14_ADOBE = seg(0xee, [...ascii("Adobe"), 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]);

// GPS latitude 51/1, 30/1, 2614/100 (London) as big-endian TIFF rationals.
export const GPS_RATIONALS = [0, 0, 0, 51, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0x0a, 0x36, 0, 0, 0, 100];
// APP1 Exif: TIFF header, IFD0 holding only a GPSInfo pointer, then a GPS IFD
// with GPSLatitudeRef "N" and GPSLatitude.
export const APP1_EXIF_GPS = seg(0xe1, [
  ...ascii("Exif"), 0x00, 0x00,
  0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,                 // "MM", 42, IFD0 at 8
  0x00, 0x01, 0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, // GPSInfo -> 26
  0x00, 0x00, 0x00, 0x00,                                         // no IFD1
  0x00, 0x02,                                                     // GPS IFD: 2 entries
  0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x4e, 0x00, 0x00, 0x00, // LatitudeRef "N"
  0x00, 0x02, 0x00, 0x05, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x38, // Latitude -> 56
  0x00, 0x00, 0x00, 0x00,
  ...GPS_RATIONALS,
]);
export const APP1_XMP = seg(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0x00, ...ascii("<x:xmpmeta><exif:GPSLatitude>51,30.4N</exif:GPSLatitude></x:xmpmeta>")]);
export const APP2_ICC = seg(0xe2, [...ascii("ICC_PROFILE"), 0x00, 0x01, 0x01, ...ascii("appl iPhone 15 Pro")]);
export const APP13_IPTC = seg(0xed, [...ascii("Photoshop 3.0"), 0x00, ...ascii("8BIM"), 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
export const COM = seg(0xfe, ascii("Shot on a phone at home"));

/** A client-shaped JPEG: no metadata segments at all. */
export const CLEAN = () => new Uint8Array([...SOI, ...APP0_JFIF, ...DQT, ...SOF0, ...DHT, ...SOS, ...SCAN, ...EOI]);

/** Index of the first occurrence of `needle` in `hay`, or -1. */
export const indexOfBytes = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

/** Markers of the segments before the first SOS (the metadata region). */
export const headerMarkers = (bytes) => {
  const out = [];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const m = bytes[i + 1];
    out.push(m);
    if (m === 0xda) break;
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return out;
};
