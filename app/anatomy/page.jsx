// app/anatomy/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The index for the per-muscle pages. Sorted by how many movements reach the
// muscle, so the deepest sections lead — same instinct as the library index.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { allTrainedMuscles, contributorsFor, muscleSlug } from "@/lib/library";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

const URL = "https://heatwayve.app/anatomy";

export const metadata = {
  title: "Explore your anatomy — what actually trains each muscle",
  description:
    "One page per muscle: every movement that trains it, ranked by the share of a set it genuinely credits. Not a list of exercises — a ranking of contribution.",
  alternates: { canonical: URL },
};

export default function AnatomyIndexPage() {
  const muscles = allTrainedMuscles()
    .map((m) => ({ muscle: m, n: contributorsFor(m).length }))
    .sort((a, b) => b.n - a.n || a.muscle.localeCompare(b.muscle));

  const listLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Explore your anatomy",
    url: URL,
    description: metadata.description,
    hasPart: muscles.map((m) => ({
      "@type": "WebPage",
      name: m.muscle,
      url: `${URL}/${muscleSlug(m.muscle)}`,
    })),
  };

  return (
    <div style={{ padding: "40px 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(listLd) }} />

      <Link href="/" style={{ fontSize: 13, color: T.ink2, fontFamily: T.text, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3} /> Heatwayve
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>
          <span style={{ fontFamily: T.measured }}>{muscles.length}</span> muscles
        </div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>Explore your anatomy</h1>
        <p style={{ fontSize: 16, color: T.ink2, marginTop: 14, lineHeight: 1.6 }}>
          Everyone can hand you a list of exercises for a body part. Fewer can
          tell you how much of a set each one actually credits — which is the
          number that decides whether your week adds up, and the reason your
          arms are probably doing more than you think.
        </p>
      </div>

      <ul style={{ listStyle: "none", margin: "34px 0 0", padding: 0 }}>
        {muscles.map(({ muscle, n }) => (
          <li key={muscle} style={{ borderBottom: `1px solid ${T.ruleFaint}` }}>
            <Link href={`/anatomy/${muscleSlug(muscle)}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "14px 0", textDecoration: "none" }}>
              <span style={{ fontSize: 16, color: T.ink, fontFamily: T.text }}>{muscle}</span>
              <span style={{ fontSize: 12, color: T.ink3, flexShrink: 0 }}>
                <span style={{ fontFamily: T.measured }}>{n}</span> movements
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 40, fontSize: 14, color: T.ink3, lineHeight: 1.6 }}>
        Reading the other way round — one movement, every muscle it touches — is{" "}
        <Link href="/library" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
          the exercise library
        </Link>. The weekly arithmetic behind both is on{" "}
        <Link href="/volume-landmarks" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
          volume landmarks
        </Link>.
      </p>
    </div>
  );
}
