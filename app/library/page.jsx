// app/library/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Public exercise library index — the organic-SEO surface (SEO pass item 4).
// Fully static server component: every exercise Forge tracks, grouped by the
// muscle it primarily trains, linking to a per-exercise page rendered from
// the same anatomy data the app's volume audit runs on.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { libraryByMuscle, LIBRARY } from "@/lib/library";
import { T } from "@/lib/tokens";
import Glyph from "@/components/Glyph";
import LibraryMasthead from "./masthead";

export const metadata = {
  title: "Exercise Library",
  description:
    `${LIBRARY.length} exercises with honest per-muscle volume weights — what each movement actually trains, how Heatwayve progresses it, and what to swap it for.`,
  alternates: { canonical: "https://heatwayve.app/library" },
};

export default function LibraryIndexPage() {
  const groups = libraryByMuscle();
  return (
    <div style={{ minHeight: "100vh", padding: "max(52px, calc(env(safe-area-inset-top, 0px) + 12px)) 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <Link href="/" style={{ fontSize: 13, color: T.ink2, fontFamily: T.text, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3}/> Home
      </Link>

      {/* Masthead — client island so About's word rides the kicker line
          while its open panel drops in AFTER the support line (§12.2 + the
          v4-review nit: the masthead never displaces). */}
      <LibraryMasthead count={LIBRARY.length} />

      {groups.map(({ muscle, exercises }) => (
        <section key={muscle} style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 4px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
            {muscle} · <span style={{ fontFamily: T.measured }}>{exercises.length}</span>
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {exercises.map((e) => (
              <li key={e.slug} style={{ borderBottom: `1px solid ${T.ruleFaint}` }}>
                <Link
                  href={`/library/${e.slug}`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "13px 0", textDecoration: "none" }}
                >
                  <span style={{ fontSize: 16, fontWeight: 400, color: T.ink, fontFamily: T.text }}>{e.name}</span>
                  <span style={{ fontSize: 12, color: T.ink3, fontFamily: T.text, flexShrink: 0 }}>{e.categoryLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p style={{ marginTop: 48, fontSize: 13, color: T.ink3, fontFamily: T.text, lineHeight: 1.6 }}>
        Train with intention. <Link href="/" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>Open Heatwayve</Link> — it programmes,
        progresses, and audits all of this for you.
      </p>
    </div>
  );
}
