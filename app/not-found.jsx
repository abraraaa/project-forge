import Link from "next/link";
import { T } from "@/lib/tokens";

export const metadata = {
  title: "Not found",
  robots: { index: false },
};

// The default Next 404 strands the user: a bare line of text, no way back.
// Server component by design — no client JS needed to get someone home.
export default function NotFound() {
  return (
    <main style={{
      color: T.text1, fontFamily: T.sans,
      padding: "88px 24px 24px",
      display: "flex", flexDirection: "column", alignItems: "flex-start",
    }}>
      <div style={{
        fontSize: 11, fontWeight: 500, color: T.text3,
        letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12,
      }}>
        404
      </div>

      <h1 style={{
        fontFamily: T.serif, fontSize: 40, fontWeight: 300,
        lineHeight: 1.1, letterSpacing: "-0.02em", margin: 0,
      }}>
        Nothing here.<br />
        <span style={{ color: T.coral, fontStyle: "italic" }}>Back to the work.</span>
      </h1>

      <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, margin: "14px 0 32px", maxWidth: "34ch" }}>
        This page doesn&apos;t exist — or it moved. Your training is where you left it.
      </p>

      <Link
        href="/"
        style={{
          padding: "14px 22px", background: T.coral, color: T.bg0,
          borderRadius: T.r.lg, fontFamily: T.serif, fontSize: 16,
          textDecoration: "none", display: "inline-block",
        }}
      >
        Take me home →
      </Link>
    </main>
  );
}
