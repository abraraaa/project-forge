// components/QrCode.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The share link as a QR code, for the trainer's invite sheet. Dark modules
// on a light plate in both themes (an inverted code is not read by every
// scanner), with the standard four-module quiet zone inside the viewBox.
// crispEdges keeps module edges sharp at any scale. No hooks, so usable
// anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeQr, qrToSvgPath } from "@/lib/qr";

const QUIET = 4;

/** @param {{ text: string, width?: number, height?: number }} props */
export default function QrCode({ text, width = 168, height = 168 }) {
  if (!text) return null;
  const { size, modules } = encodeQr(text);
  const span = size + 2 * QUIET;
  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={width}
      height={height}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for the share link"
      style={{ display: "block", borderRadius: 6 }}
    >
      <rect width={span} height={span} fill="#F7F2EC" />
      <path d={qrToSvgPath(modules, size)} transform={`translate(${QUIET} ${QUIET})`} fill="#1A1512" />
    </svg>
  );
}
