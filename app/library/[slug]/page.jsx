// app/library/[slug]/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Per-exercise page — fully static (generateStaticParams over the whole
// catalogue, dynamicParams off). The content IS the app's own data: the
// weighted muscle contributions the volume audit computes with, the
// progression category the engine steps by, and the swap alternatives the
// session screen offers. Rendered from lib/library.js so page and app can
// never disagree.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { notFound } from "next/navigation";
import { LIBRARY, getExercise, exerciseDescription } from "@/lib/library";
import { getTempo, decodeTempo, TEMPO_SOURCES } from "@/lib/exercise-tempo";
import { T, DISPLAY } from "@/lib/tokens";
import Glyph from "@/components/Glyph";
import { MonoNums } from "@/components/ui";

export const dynamicParams = false;

export function generateStaticParams() {
  return LIBRARY.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const entry = getExercise(slug);
  if (!entry) return {};
  return {
    title: `${entry.name} — muscles worked & progression`,
    description: exerciseDescription(entry),
    alternates: { canonical: `https://heatwayve.app/library/${entry.slug}` },
  };
}

// Contribution bar — weight is 0..1 of a full set's volume.
function MuscleBar({ muscle, weight, primary = false }) {
  // Contribution is a magnitude → it rides the thermal ramp: a full set's
  // worth of stimulus runs hot, fractional contributions cool. Height and
  // the printed number carry the value too (redundancy law).
  const heat = weight >= 0.95 ? T.heat[3] : weight >= 0.5 ? T.heat[2] : weight >= 0.25 ? T.heat[1] : T.heat[0];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 44px", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.ruleFaint}` }}>
      <span style={{ fontSize: 13, fontWeight: primary ? 500 : 400, color: primary ? T.ink : T.ink2 }}>{muscle}</span>
      <span style={{ height: primary ? 8 : 6, background: T.well, overflow: "hidden", display: "block" }} aria-hidden="true">
        <span style={{ display: "block", height: "100%", width: `${weight * 100}%`, background: heat }} />
      </span>
      <span style={{ fontSize: 12, color: T.ink2, fontFamily: T.measured, textAlign: "right" }}>
        {weight.toFixed(weight === 1 ? 0 : 2).replace(/^0/, "")}
      </span>
    </div>
  );
}

// Tempo prescription — data from lib/exercise-tempo.js (externally sourced,
// reviewed, honestly labelled). Isometric holds have tempo:null and render
// the hold guidance instead of fake digits.
function TempoSection({ name }) {
  const t = getTempo(name);
  if (!t) return null;
  const segments = t.tempo ? decodeTempo(t.tempo) : null;
  return (
    <section style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 10px" }}>
        Tempo
      </h2>
      {segments ? (
        <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
          {segments.map((seg, i) => (
            <div key={i}>
              <span style={{ fontFamily: T.measured, fontSize: 32, fontWeight: 300, letterSpacing: "-0.03em", color: seg.n === "X" ? T.heat[3] : T.ink }}>{seg.n}</span>
              <span style={{ display: "block", fontSize: 11, color: T.ink3, marginTop: 2 }}>{seg.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 15, color: T.ink, margin: 0 }}>
          Hold, don&apos;t count reps.
        </p>
      )}
      <p style={{ fontSize: 13, color: T.ink2, marginTop: 12, lineHeight: 1.6 }}>{t.principle}</p>
      {t.note && <p style={{ fontSize: 13, color: T.ink3, marginTop: 8, lineHeight: 1.6 }}>{t.note}</p>}
      <p style={{ fontSize: 12, color: T.ink3, marginTop: 10, lineHeight: 1.6 }}>
        {t.evidence === "derived" ? "Derived from tempo research on this movement class — " : ""}
        {t.sources.map((s) => TEMPO_SOURCES[s]?.cite.split(".")[0]).filter(Boolean).join("; ")}.
      </p>
    </section>
  );
}

export default async function ExercisePage({ params }) {
  const { slug } = await params;
  const entry = getExercise(slug);
  if (!entry) notFound();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Exercise Library", item: "https://heatwayve.app/library" },
      { "@type": "ListItem", position: 2, name: entry.name, item: `https://heatwayve.app/library/${entry.slug}` },
    ],
  };

  return (
    <div style={{ minHeight: "100vh", padding: "max(52px, calc(env(safe-area-inset-top, 0px) + 12px)) 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />

      <Link href="/library" style={{ fontSize: 13, color: T.ink3, fontFamily: T.text, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Glyph name="arrowLeft" size={12}/> Library
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 13, color: T.ink3, marginBottom: 8 }}>
          {entry.categoryLabel}
        </div>
        <h1 style={{ ...DISPLAY, fontSize: 38, color: T.ink, margin: 0 }}>{entry.name}</h1>
        <p style={{ fontSize: 15, color: T.ink2, marginTop: 12, lineHeight: 1.6 }}>
          Trains <span style={{ color: T.ink, fontWeight: 500 }}>{entry.primary.toLowerCase()}</span> first
          {entry.secondary.length > 0
            ? `, with real work landing on ${entry.secondary.slice(0, 3).map((s) => s.muscle.toLowerCase()).join(", ")}${entry.secondary.length > 3 ? " and more" : ""}.`
            : " — focused, direct, nothing hidden in the movement."}
        </p>
      </div>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 6px" }}>
          Muscle contribution per set
        </h2>
        <MuscleBar muscle={entry.primary} weight={1} primary />
        {entry.secondary.map((s) => (
          <MuscleBar key={s.muscle} muscle={s.muscle} weight={s.weight} />
        ))}
        <p style={{ fontSize: 13, color: T.ink3, marginTop: 12, lineHeight: 1.6 }}>
          These are the weights Heatwayve&apos;s volume audit actually computes with — deliberately
          conservative, so compounds don&apos;t masquerade as full coverage. A <span style={{ fontFamily: T.measured }}>0.5</span> means a set
          counts as half a set for that muscle: meaningful help, not a replacement for direct work.
        </p>
      </section>

      <TempoSection name={entry.name} />

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 6px" }}>
          How Heatwayve progresses it
        </h2>
        <p style={{ fontSize: 14, color: T.ink2, lineHeight: 1.6, margin: 0 }}><MonoNums>{entry.progression}</MonoNums></p>
      </section>

      {entry.swaps.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h2 style={{ fontSize: 13, fontWeight: 400, color: T.ink3, margin: "0 0 6px" }}>
            Swap it for
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {entry.swaps.map((s) => (
              <li key={s.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "11px 0", borderBottom: `1px solid ${T.ruleFaint}` }}>
                {s.slug ? (
                  <Link href={`/library/${s.slug}`} style={{ fontSize: 15, fontWeight: 400, color: T.ink, fontFamily: T.text, textDecoration: "none" }}>
                    {s.name}
                  </Link>
                ) : (
                  <span style={{ fontSize: 15, fontWeight: 400, color: T.ink, fontFamily: T.text }}>{s.name}</span>
                )}
                <span style={{ fontSize: 12, color: T.ink3, fontFamily: T.text, flexShrink: 0 }}>{s.equipment}</span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 13, color: T.ink3, marginTop: 12, lineHeight: 1.6 }}>
            Same movement pattern, same progression continuity — these are the alternatives the
            app offers mid-session when a rack is taken or equipment isn&apos;t there.
          </p>
        </section>
      )}

      <p style={{ marginTop: 48, fontSize: 13, color: T.ink3, fontFamily: T.text, lineHeight: 1.6 }}>
        Train with intention. <Link href="/" style={{ color: T.ink, textDecoration: "underline", textUnderlineOffset: 3 }}>Open Heatwayve</Link> — it prescribes
        the weight, watches the reps, and does this arithmetic for every set you log.
      </p>
    </div>
  );
}
