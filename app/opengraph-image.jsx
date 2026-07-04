// app/opengraph-image.jsx — generated Open Graph card (1200×630).
// Next wires this into og:image + twitter:image automatically (with
// metadataBase from app/layout.jsx making the URL absolute), so no binary
// asset ships in the repo and the card stays in step with the palette.
// Satori (the renderer) can't do SVG turbulence, so the grain is implied by
// the warm field + glow rather than literal texture.
import { ImageResponse } from "next/og";

export const alt = "Forge — Train with intention";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

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
          backgroundColor: "#131110",
          backgroundImage:
            "radial-gradient(ellipse 700px 480px at 18% 20%, rgba(224,149,106,0.22), transparent 62%), radial-gradient(ellipse 640px 460px at 85% 85%, rgba(196,168,130,0.16), transparent 62%)",
        }}
      >
        <div
          style={{
            fontSize: 34,
            letterSpacing: "0.28em",
            color: "#E0956A",
            marginBottom: 28,
          }}
        >
          FORGE
        </div>
        <div
          style={{
            fontSize: 92,
            fontWeight: 400,
            color: "#EDEBE7",
            lineHeight: 1.08,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span>Train with</span>
          <span style={{ fontStyle: "italic", color: "#C4A882" }}>intention.</span>
        </div>
        <div style={{ fontSize: 30, color: "#A09890", marginTop: 36, maxWidth: 820 }}>
          Volume audits · focus-aware rotation · progression that stays honest
        </div>
      </div>
    ),
    size
  );
}
