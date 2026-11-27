// Server-side JPEG metadata strip: metadata segments go, everything else is
// copied byte for byte, and a malformed segment table is refused (null).

import { describe, it, expect } from "vitest";
import { stripJpegMetadata } from "../lib/jpeg-strip.js";
import {
  SOI, EOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN, APP14_ADOBE,
  APP1_EXIF_GPS, APP1_XMP, APP2_ICC, APP13_IPTC, COM, GPS_RATIONALS,
  CLEAN, seg, indexOfBytes, headerMarkers,
} from "./fixtures/jpeg-segments.js";

const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => [...p]));

describe("stripJpegMetadata — drops metadata, keeps the image byte for byte", () => {
  it("an APP1 Exif segment carrying GPS comes out, the rest is identical", () => {
    const camera = bytes(SOI, APP0_JFIF, APP1_EXIF_GPS, DQT, SOF0, DHT, SOS, SCAN, EOI);
    expect(indexOfBytes(camera, GPS_RATIONALS)).toBeGreaterThan(0);
    const out = stripJpegMetadata(camera);
    expect(out).toEqual(CLEAN());
    expect(indexOfBytes(out, GPS_RATIONALS)).toBe(-1);
    expect(headerMarkers(out)).not.toContain(0xe1);
  });

  it("XMP, ICC, IPTC and comments go wherever they sit in the header", () => {
    const tagged = bytes(SOI, APP1_EXIF_GPS, APP0_JFIF, APP2_ICC, APP1_XMP, DQT, COM, APP13_IPTC, SOF0, DHT, COM, SOS, SCAN, EOI);
    expect(stripJpegMetadata(tagged)).toEqual(CLEAN());
  });

  it("vendor APPn blocks go; APP0 and APP14 (Adobe colour transform) stay", () => {
    const app3 = seg(0xe3, [0x01, 0x02, 0x03]);
    const app15 = seg(0xef, [0x04]);
    const input = bytes(SOI, APP0_JFIF, app3, APP14_ADOBE, app15, DQT, SOF0, DHT, SOS, SCAN, EOI);
    expect(stripJpegMetadata(input)).toEqual(bytes(SOI, APP0_JFIF, APP14_ADOBE, DQT, SOF0, DHT, SOS, SCAN, EOI));
  });

  it("metadata between progressive scans goes; every scan stays", () => {
    const input = bytes(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN, COM, DHT, SOS, SCAN, EOI);
    expect(stripJpegMetadata(input)).toEqual(bytes(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN, DHT, SOS, SCAN, EOI));
  });

  it("bytes after the first EOI (an appended second image with Exif) are dropped", () => {
    const appended = bytes(CLEAN(), SOI, APP1_EXIF_GPS, SOF0, SOS, SCAN, EOI);
    expect(stripJpegMetadata(appended)).toEqual(CLEAN());
  });

  it("fill bytes before a kept marker are kept", () => {
    const input = bytes(SOI, APP0_JFIF, [0xff, 0xff], DQT, SOF0, DHT, SOS, SCAN, EOI);
    expect(stripJpegMetadata(input)).toEqual(input);
  });
});

describe("stripJpegMetadata — a client-prepared JPEG passes through unchanged", () => {
  it("returns the same bytes when there is nothing to drop", () => {
    const clean = CLEAN();
    const out = stripJpegMetadata(clean);
    expect(out).toBe(clean);
    expect(out).toEqual(CLEAN());
  });
});

describe("stripJpegMetadata — malformed or truncated input is refused", () => {
  const clean = CLEAN();
  const cases = {
    "empty": new Uint8Array([]),
    "not a JPEG": bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    "SOI only": bytes(SOI),
    "truncated inside a segment": clean.slice(0, 10),
    "truncated inside the scan": bytes(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN),
    "truncated mid-scan ending on FF": bytes(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN, [0xff]),
    "segment length below 2": bytes(SOI, [0xff, 0xe1, 0x00, 0x01], DQT, SOF0, SOS, SCAN, EOI),
    "segment length past the end": bytes(SOI, [0xff, 0xe1, 0xff, 0xff, 0x45, 0x78], EOI),
    "junk where a marker belongs": bytes(SOI, APP0_JFIF, [0x00, 0x00], DQT, SOF0, SOS, SCAN, EOI),
    "stuffed zero outside a scan": bytes(SOI, [0xff, 0x00], APP0_JFIF, SOF0, SOS, SCAN, EOI),
    "second SOI in the header": bytes(SOI, APP0_JFIF, SOI, SOF0, SOS, SCAN, EOI),
    "no EOI after the header": bytes(SOI, APP0_JFIF, DQT),
  };
  for (const [label, input] of Object.entries(cases)) {
    it(label, () => {
      expect(stripJpegMetadata(input)).toBeNull();
    });
  }
  it("null input", () => {
    expect(stripJpegMetadata(/** @type {any} */ (null))).toBeNull();
  });
});
