// app/opengraph-image.jsx — generated Open Graph card (1200×630).
// Next wires this into og:image + twitter:image automatically (with
// metadataBase from app/layout.jsx making the URL absolute), so no binary
// asset ships in the repo and the card stays in step with the palette.
//
// Bone & Ember: ink on uncoated bone, the thermal ramp as the one accent.
// Satori can't load the app's webfonts without bundling font files, so the
// card leans on scale and the ramp rather than the display face — the
// mark's arcs + the five-step ramp carry the brand.
import { ImageResponse } from "next/og";

export const alt = "Heatwayve — Train with intention";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const RAMP = ["#E3CFC6", "#D3A492", "#C07B63", "#A65340", "#82301F"];

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
          backgroundColor: "#F2E9E3",
          color: "#241C19",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 34 }}>
          {/* The open-aperture mark — two arcs, broken apex. */}
          <svg width="56" height="56" viewBox="0 0 128 128">
            <rect width="128" height="128" rx="24" fill="#A65340" />
            <path d="M28 96 A 38 38 0 0 1 51 63" fill="none" stroke="#F6EEE8" strokeWidth="14" strokeLinecap="round" />
            <path d="M77 63 A 38 38 0 0 1 100 96" fill="none" stroke="#F6EEE8" strokeWidth="14" strokeLinecap="round" />
            <path d="M47 96 A 17 17 0 0 1 81 96" fill="none" stroke="rgba(246,238,232,0.45)" strokeWidth="11" strokeLinecap="round" />
          </svg>
          <div style={{ fontSize: 30, color: "#6A5B54" }}>Heatwayve</div>
        </div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 500,
            color: "#241C19",
            lineHeight: 1.05,
          }}
        >
          Train with intention
        </div>
        <div style={{ fontSize: 30, color: "#6A5B54", marginTop: 34, maxWidth: 860 }}>
          Volume audits · focus-aware rotation · progression that stays honest
        </div>
        {/* The thermal ramp — one scale for all intensity. */}
        <div style={{ display: "flex", height: 10, width: 420, marginTop: 44 }}>
          {RAMP.map((c) => (
            <div key={c} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </div>
      </div>
    ),
    size
  );
}
