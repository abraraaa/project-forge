// app/volume-landmarks/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The concept piece behind the number every Lab row is judged against.
//
// This is the defensible content play: everyone else prescribes "3-4 sets of
// 8-12". We can say how many weighted sets a week each muscle wants, where the
// productive band sits, and — the part nobody else does — exactly how a set is
// apportioned across the muscles that actually did the work.
//
// The table is BUILT from VOLUME_TARGETS, the same constant the audit engine
// runs on, so the page cannot drift from what the app computes. Same discipline
// as the library pages.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { VOLUME_TARGETS, VOLUME_SOURCES } from "@/lib/volume-audit";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

const URL = "https://heatwayve.app/volume-landmarks";

export const metadata = {
  title: "MEV, MAV and MRV — how much volume each muscle wants",
  description:
    "The three weekly volume landmarks, in weighted sets per muscle: the least that grows you, the window where most growth happens, and the ceiling past which sets cost more than they earn.",
  alternates: { canonical: URL },
  openGraph: {
    title: "MEV, MAV and MRV — volume landmarks explained",
    description:
      "Weekly volume landmarks in weighted sets per muscle, with the exact per-muscle numbers Heatwayve audits against.",
    url: URL,
    type: "article",
  },
};

// Ordered for reading rather than for the engine: the big movers first.
const READING_ORDER = [
  "Quads", "Hamstrings", "Glutes", "Calves",
  "Chest", "Lats", "Upper Back", "Traps", "Erectors",
  "Front Delts", "Side Delts", "Rear Delts",
  "Biceps", "Triceps", "Core",
];

const TERMS = [
  {
    abbr: "MEV",
    name: "Minimum Effective Volume",
    body: "The least work that still moves the needle. Below it you are maintaining at best — the sessions happen, the muscle stays where it is. This is the number worth caring about most, because almost everyone who is stuck is stuck under it on something.",
  },
  {
    abbr: "MAV",
    name: "Maximum Adaptive Volume",
    body: "The upper edge of the productive window. Between MEV and MAV is where most growth actually accrues, and where a sane programme spends its time. It is a band, not a bullseye.",
  },
  {
    abbr: "MRV",
    name: "Maximum Recoverable Volume",
    body: "The ceiling. Past it the sets still happen, the fatigue still accumulates, and the adaptation does not follow — you are paying for work you cannot recover from. Going over occasionally is a training decision. Living over it is a slow injury.",
  },
];

export default function VolumeLandmarksPage() {
  const rows = READING_ORDER.filter((m) => VOLUME_TARGETS[m]).map((m) => ({ muscle: m, ...VOLUME_TARGETS[m] }));

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Heatwayve", item: "https://heatwayve.app/" },
      { "@type": "ListItem", position: 2, name: "Volume landmarks", item: URL },
    ],
  };

  // DefinedTermSet is the honest type here: the page's substance is three
  // defined terms and the numbers attached to them. Retrieval systems can then
  // answer "what is MEV" from structure rather than by parsing prose.
  const termsLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    name: "Weekly training volume landmarks",
    url: URL,
    description: metadata.description,
    hasDefinedTerm: TERMS.map((t) => ({
      "@type": "DefinedTerm",
      name: t.name,
      alternateName: t.abbr,
      description: t.body,
      inDefinedTermSet: URL,
    })),
    citation: Object.values(VOLUME_SOURCES).map((src) => ({
      "@type": "CreativeWork",
      name: src.cite,
      ...(src.url ? { url: src.url } : {}),
    })),
  };

  return (
    <div style={{ padding: "40px 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(termsLd) }} />

      <Link href="/" style={{ fontSize: 13, color: T.ink2, fontFamily: T.text, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12} color={T.ink3} /> Heatwayve
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>Volume landmarks</div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>How much is enough</h1>
        <p style={{ fontSize: 16, color: T.ink2, marginTop: 14, lineHeight: 1.6 }}>
          Almost every programme tells you how many sets to do today. Very few
          tell you how many your <em>chest</em> got this week, which is the
          number that decides whether it grows.
        </p>
      </div>

      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 14px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          The three numbers
        </h2>
        {TERMS.map((t) => (
          <div key={t.abbr} style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 5 }}>
              <span style={{ fontFamily: T.measured, fontSize: 17, color: T.ink }}>{t.abbr}</span>
              <span style={{ fontSize: 14, color: T.ink2 }}>{t.name}</span>
            </div>
            <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65, margin: 0 }}>{t.body}</p>
          </div>
        ))}
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          The unit: weighted sets per week
        </h2>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65 }}>
          Not sessions, not exercises, not hours. Sets, counted per muscle,
          across the whole week. Three chest sets on Monday and three on
          Thursday is six, and six is the number that matters.
        </p>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65, marginTop: 12 }}>
          <strong style={{ color: T.ink, fontWeight: 500 }}>Weighted</strong> is
          the part that usually gets skipped. A barbell row is not one set of
          &ldquo;back&rdquo;. It is a full set for your lats, most of a set for
          your upper back, a real share for your biceps, and a smaller one for
          your rear delts and forearms. Count it as one set of back and you
          will under-count your arms every week of your life, then wonder why
          they never catch up.
        </p>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65, marginTop: 12 }}>
          Heatwayve apportions every logged set across the muscles that did the
          work, using a per-exercise contribution table — and then holds the
          weekly total against the landmarks below. The same numbers drive both.
          You can read the exact split for any movement in{" "}
          <Link href="/library" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
            the exercise library
          </Link>.
        </p>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          Weekly, but not all at once
        </h2>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65 }}>
          The dose is weekly. How you spread it still matters, just less than
          people think. The meta-analytic answer is that major muscle groups
          respond best trained{" "}
          <strong style={{ color: T.ink, fontWeight: 500 }}>at least twice a week</strong>{" "}
          — and that whether three beats two is, on the current evidence,
          undetermined.
        </p>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65, marginTop: 12 }}>
          Which is the useful version of the finding: hit your weekly number
          across two or more sessions and the frequency question is answered.
          Twelve sets of chest in one heroic Monday is not the same twelve. The
          three-day A/B/C rotation exists for this reason — each muscle comes
          around more than once, without anyone having to plan it.
        </p>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 4px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          The landmarks, per muscle
        </h2>
        <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, margin: "10px 0 14px" }}>
          Weighted sets per week. These are the exact values Heatwayve audits
          against — this table is generated from them, so it cannot drift.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 0", color: T.ink3, fontWeight: 400, fontSize: 12, borderBottom: `1px solid ${T.rule}` }}>Muscle</th>
                {["MEV", "MAV", "MRV"].map((h) => (
                  <th key={h} style={{ textAlign: "right", padding: "8px 0 8px 16px", color: T.ink3, fontWeight: 400, fontSize: 12, borderBottom: `1px solid ${T.rule}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.muscle}>
                  <td style={{ padding: "9px 0", color: T.ink, borderBottom: `1px solid ${T.ruleFaint}` }}>{r.muscle}</td>
                  {[r.mev, r.mav, r.mrv].map((v, i) => (
                    <td key={i} style={{ padding: "9px 0 9px 16px", textAlign: "right", fontFamily: T.measured, color: T.ink2, borderBottom: `1px solid ${T.ruleFaint}` }}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, marginTop: 14 }}>
          Two entries deserve a note. <strong style={{ color: T.ink2, fontWeight: 500 }}>Traps</strong> and{" "}
          <strong style={{ color: T.ink2, fontWeight: 500 }}>Core</strong> carry an
          MEV of zero — not because they do not matter, but because deadlifts,
          rows and carries already deliver plenty indirectly. Their ceiling is
          the useful half. <strong style={{ color: T.ink2, fontWeight: 500 }}>Erectors</strong>{" "}
          are the same idea, sharper: that row is a fatigue budget, there to
          warn you when a deadlift-heavy stretch is quietly stacking axial load.
        </p>
        <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, marginTop: 10 }}>
          Each deltoid head is judged on its own. Lumping them together is how
          side delts end up permanently under-trained behind a pile of pressing.
        </p>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          What these numbers are not
        </h2>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65 }}>
          They are not a measurement of you. Volume tolerance moves with
          training age, sleep, stress, how much food you are eating and what
          else is in the week. Two people with identical numbers can sit fifty
          per cent apart on what they can actually recover from.
        </p>
        <p style={{ fontSize: 15, color: T.ink2, lineHeight: 1.65, marginTop: 12 }}>
          Treat them as a well-reasoned starting point and let your own
          evidence correct them. A band you sit inside comfortably and keep
          progressing on is right for you, whatever the table says. The honest
          use of a landmark is to notice you are nowhere near one.
        </p>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 12px", paddingBottom: 6, borderBottom: `1px solid ${T.rule}` }}>
          Where this comes from
        </h2>
        {Object.entries(VOLUME_SOURCES).map(([k, src]) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: T.ink2, lineHeight: 1.6, margin: 0 }}>
              {src.url
                ? <a href={src.url} rel="noopener" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>{src.cite}</a>
                : src.cite}
            </p>
            {src.note && (
              <p style={{ fontSize: 13, color: T.ink3, lineHeight: 1.6, margin: "5px 0 0" }}>{src.note}</p>
            )}
          </div>
        ))}
      </section>

      <p style={{ marginTop: 44, fontSize: 14, color: T.ink3, lineHeight: 1.6 }}>
        Heatwayve does this arithmetic for you every week, per muscle, from the
        sets you actually logged.{" "}
        <Link href="/" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>
          Open the app
        </Link>.
      </p>
    </div>
  );
}
