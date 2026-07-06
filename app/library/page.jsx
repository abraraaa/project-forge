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

export const metadata = {
  title: "Exercise Library",
  description:
    `${LIBRARY.length} exercises with honest per-muscle volume weights — what each movement actually trains, how Forge progresses it, and what to swap it for.`,
  alternates: { canonical: "https://theforged.fit/library" },
};

export default function LibraryIndexPage() {
  const groups = libraryByMuscle();
  return (
    <div style={{ minHeight: "100vh", padding: "max(52px, calc(env(safe-area-inset-top, 0px) + 12px)) 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <Link href="/" style={{ fontSize: 12, color: T.text3, fontFamily: T.sans, textDecoration: "none" }}>
        ← Forge
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
          Exercise library
        </div>
        <h1 style={{ fontFamily: T.serif, fontSize: 42, fontWeight: 300, lineHeight: 1.1, margin: 0 }}>
          What each lift<br />
          <span style={{ color: T.gold, fontStyle: "italic" }}>actually trains.</span>
        </h1>
        <p style={{ fontSize: 14, color: T.text2, marginTop: 14, lineHeight: 1.6 }}>
          {`${LIBRARY.length} movements`}, each with the weighted muscle contributions
          Forge uses to audit your training volume — a squat isn&apos;t &quot;legs&quot;,
          it&apos;s quads first, glutes and hamstrings meaningfully, core along for
          the ride. The same numbers the app computes with, published.
        </p>
      </div>

      {groups.map(({ muscle, exercises }) => (
        <section key={muscle} style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>
            {muscle} · {exercises.length}
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {exercises.map((e) => (
              <li key={e.slug} style={{ borderBottom: `1px solid ${T.bg3}` }}>
                <Link
                  href={`/library/${e.slug}`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "13px 0", textDecoration: "none" }}
                >
                  <span style={{ fontFamily: T.serif, fontSize: 17, fontWeight: 300, color: T.text1 }}>{e.name}</span>
                  <span style={{ fontSize: 11, color: T.text4, fontFamily: T.sans, flexShrink: 0 }}>{e.categoryLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p style={{ marginTop: 48, fontSize: 13, color: T.text3, fontFamily: T.serif, fontStyle: "italic", lineHeight: 1.6 }}>
        Train with intention. <Link href="/" style={{ color: T.gold }}>Open Forge</Link> — it programmes,
        progresses, and audits all of this for you.
      </p>
    </div>
  );
}
