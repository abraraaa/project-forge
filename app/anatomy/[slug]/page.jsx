// app/anatomy/[slug]/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// One page per muscle: every movement that trains it, ranked by how much.
//
// The library answers "what does this exercise train". This answers the
// question people actually type — "what trains rear delts" — and it is the one
// question the literature cannot answer for you, because the answer lives in
// our weighted contribution table. A meta-analysis can tell you how many sets
// a week; only we can tell you that a face pull is a full set of rear delts and
// a barbell row is three-tenths of one.
//
// Everything on the page is derived from EXERCISE_ANATOMY and VOLUME_TARGETS —
// the same constants the audit runs on — so it cannot drift from the app.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { notFound } from "next/navigation";
import { allTrainedMuscles, contributorsFor, getMuscleBySlug, muscleSlug } from "@/lib/library";
import { VOLUME_TARGETS } from "@/lib/volume-audit";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

export function generateStaticParams() {
  return allTrainedMuscles().map((m) => ({ slug: muscleSlug(m) }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const muscle = getMuscleBySlug(slug);
  if (!muscle) return {};
  const n = contributorsFor(muscle).length;
  const low = muscle.toLowerCase();
  return {
    // Kept under 70 with the "| Heatwayve" template applied — Bing warns past
    // that, and the head term ("what trains X") has to survive the trim.
    title: `What trains ${low} — ${n} movements, ranked`,
    description: `Every exercise that trains ${low}, ranked by how much of a set it actually credits — not a list of "${low} exercises", but the weighted share each movement contributes.`,
    alternates: { canonical: `https://heatwayve.app/anatomy/${slug}` },
  };
}

// A contribution is a share of one set. Said plainly, once, so the numbers
// down the page need no further explanation.
function shareLabel(share) {
  if (share === 1) return "a full set";
  if (share >= 0.5) return "over half a set";
  if (share >= 0.25) return "a quarter set or better";
  return "a slice";
}

export default async function MusclePage({ params }) {
  const { slug } = await params;
  const muscle = getMuscleBySlug(slug);
  if (!muscle) notFound();

  const contributors = contributorsFor(muscle);
  const primaries = contributors.filter((c) => c.isPrimary);
  const assistors = contributors.filter((c) => !c.isPrimary);
  const target = VOLUME_TARGETS[muscle] || null;
  const low = muscle.toLowerCase();
  const url = `https://heatwayve.app/anatomy/${slug}`;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Anatomy", item: "https://heatwayve.app/anatomy" },
      { "@type": "ListItem", position: 2, name: muscle, item: url },
    ],
  };

  // The ranking as data. An ItemList with explicit positions lets a retrieval
  // system answer "best exercise for rear delts" from structure, and see that
  // the ordering is a measured share rather than an opinion.
  const listLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Movements that train ${low}, ranked by contribution`,
    url,
    numberOfItems: contributors.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: contributors.slice(0, 25).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://heatwayve.app/library/${c.entry.slug}`,
      name: c.entry.name,
      description: `Contributes ${c.share.toFixed(2)} of a set to ${low}.`,
    })),
  };

  const Row = ({ c }) => (
    <li style={{ borderBottom: `1px solid ${T.ruleFaint}` }}>
      <Link href={`/library/${c.entry.slug}`}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "12px 0", textDecoration: "none" }}>
        <span style={{ fontSize: 16, color: T.ink, fontFamily: T.text }}>{c.entry.name}</span>
        <span style={{ fontFamily: T.measured, fontSize: 14, color: T.ink2, flexShrink: 0 }}>
          {c.share.toFixed(2)}
        </span>
      </Link>
    </li>
  );

  return (
    <div style={{ padding: "40px 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(listLd) }} />

      <Link href="/anatomy" style={{ fontSize: 13, color: T.ink2, fontFamily: T.text, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3} /> Anatomy
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>
          <span style={{ fontFamily: T.measured }}>{contributors.length}</span> movements train it
        </div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>{muscle}</h1>
        <p style={{ fontSize: 16, color: T.ink2, marginTop: 14, lineHeight: 1.6 }}>
          Not a list of exercises for {low}. A ranking of how much of a set
          each movement actually credits to your {low} — a different question,
          and the one that decides whether your week adds up.
        </p>
      </div>

      <section style={{ marginTop: 38 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 4px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          Trains it directly &middot; <span style={{ fontFamily: T.measured }}>{primaries.length}</span>
        </h2>
        <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, margin: "10px 0 4px" }}>
          A full set each. This is where the volume comes from when you are
          short.
        </p>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {primaries.map((c) => <Row key={c.entry.slug} c={c} />)}
        </ul>
      </section>

      {assistors.length > 0 && (
        <section style={{ marginTop: 38 }}>
          <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 4px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
            Trains it on the way past &middot; <span style={{ fontFamily: T.measured }}>{assistors.length}</span>
          </h2>
          <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, margin: "10px 0 4px" }}>
            Partial credit, and the reason most people&rsquo;s totals are higher
            than they think. The number is the share of one set.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {assistors.map((c) => <Row key={c.entry.slug} c={c} />)}
          </ul>
        </section>
      )}

      {target && (
        <section style={{ marginTop: 38 }}>
          <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
            How much {low} wants
          </h2>
          <div style={{ display: "flex", gap: 28, marginBottom: 14 }}>
            {[["MEV", target.mev], ["MAV", target.mav], ["MRV", target.mrv]].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontFamily: T.measured, fontSize: 24, color: T.ink }}>{v}</div>
                <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>{k}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65 }}>
            Weighted sets per week: the least that grows it, the productive
            window, and the ceiling. Add the shares above until you land inside
            the band —{" "}
            <Link href="/volume-landmarks" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
              how the landmarks work
            </Link>.
          </p>
        </section>
      )}

      <p style={{ marginTop: 44, fontSize: 14, color: T.ink3, lineHeight: 1.6 }}>
        {contributors[0] && (
          <>The heaviest hitter here is{" "}
            <Link href={`/library/${contributors[0].entry.slug}`} style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
              {contributors[0].entry.name}
            </Link>{" "}
            at {shareLabel(contributors[0].share)}.{" "}
          </>
        )}
        Heatwayve totals all of this for you, every week, from the sets you
        logged.{" "}
        <Link href="/" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
          Open the app
        </Link>.
      </p>
    </div>
  );
}
