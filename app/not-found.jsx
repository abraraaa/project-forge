import Link from "next/link";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

export const metadata = {
  title: "Not found",
  robots: { index: false },
};

// The default Next 404 strands the user: a bare line of text, no way back.
// Server component by design — no client JS needed to get someone home.
export default function NotFound() {
  return (
    <div style={{
      color: T.ink, fontFamily: T.text,
      padding: "88px 24px 24px",
      display: "flex", flexDirection: "column", alignItems: "flex-start",
    }}>
      <div style={{ fontSize: 13, color: T.ink3, marginBottom: 12 }}>
        404 · nothing here
      </div>

      <h1 style={{ ...DISPLAY, fontSize: 40, color: T.ink, margin: 0 }}>
        A dead end
      </h1>

      <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: "14px 0 32px", maxWidth: "34ch" }}>
        This page doesn&apos;t exist — or it moved. Your training is where you left it.
      </p>

      <Link
        href="/"
        style={{
          padding: "15px 22px", background: T.commit, color: T.commitInk,
          borderRadius: T.r, boxShadow: T.elevStrong, fontFamily: T.text,
          fontSize: 16, fontWeight: 500, textDecoration: "none",
          display: "inline-flex", alignItems: "center", gap: 8,
        }}
      >
        Take me home <Glyph name="arrowRight" size={13} />
      </Link>
    </div>
  );
}
