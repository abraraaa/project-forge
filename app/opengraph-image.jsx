// app/opengraph-image.jsx — generated Open Graph card (1200×630).
// Next wires this into og:image + twitter:image automatically (with
// metadataBase from app/layout.jsx making the URL absolute), so no binary
// asset ships in the repo and the card stays in step with the palette.
//
// Bone & Ember: ink on uncoated bone, the mark as the one accent.
// Satori can't load the app's webfonts without bundling font files, so the
// card leans on scale rather than the display face. Colours come from the
// literal hex tables in lib/tokens.js (plain data, no imports, edge-safe).
import { ImageResponse } from "next/og";
import { MODE_HEX, RAMP_HEX } from "@/lib/tokens";

export const alt = "Heatwayve — Train with intention";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = MODE_HEX.light;
const MARK = RAMP_HEX.light[3];

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          backgroundColor: INK.ground,
          color: INK.ink,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 34 }}>
          {/* The open-aperture mark — two arcs, broken apex. */}
          <svg width="56" height="56" viewBox="0 0 128 128">
            <rect width="128" height="128" rx="24" fill={MARK} />
            <path d="M28 96 A 38 38 0 0 1 51 63" fill="none" stroke="#F6EEE8" strokeWidth="14" strokeLinecap="round" />
            <path d="M77 63 A 38 38 0 0 1 100 96" fill="none" stroke="#F6EEE8" strokeWidth="14" strokeLinecap="round" />
            <path d="M47 96 A 17 17 0 0 1 81 96" fill="none" stroke="rgba(246,238,232,0.45)" strokeWidth="11" strokeLinecap="round" />
          </svg>
          <div style={{ fontSize: 30, color: INK.ink2 }}>Heatwayve</div>
        </div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 500,
            color: INK.ink,
            lineHeight: 1.05,
          }}
        >
          Train with intention
        </div>
        <div style={{ fontSize: 30, color: INK.ink2, marginTop: 34, maxWidth: 860, textWrap: "balance" }}>
          Evidence-based strength training that keeps every muscle’s weekly volume honest.
        </div>
      </div>
    ),
    size
  );
}
