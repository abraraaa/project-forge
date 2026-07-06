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
import { T } from "@/lib/tokens";

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
    alternates: { canonical: `https://theforged.fit/library/${entry.slug}` },
  };
}

// Contribution bar — weight is 0..1 of a full set's volume.
function MuscleBar({ muscle, weight, primary = false }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 44px", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.bg3}` }}>
      <span style={{ fontSize: 13, fontWeight: primary ? 500 : 400, color: primary ? T.text1 : T.text2 }}>{muscle}</span>
      <span style={{ height: 6, borderRadius: 3, background: T.bg3, overflow: "hidden", display: "block" }} aria-hidden="true">
        <span style={{ display: "block", height: "100%", width: `${weight * 100}%`, borderRadius: 3, background: primary ? T.coral : T.gold, opacity: primary ? 1 : 0.7 }} />
      </span>
      <span style={{ fontSize: 12, color: T.text3, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
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
      <h2 style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>
        Tempo
      </h2>
      {segments ? (
        <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
          {segments.map((seg, i) => (
            <div key={i}>
              <span style={{ fontFamily: T.serif, fontSize: 34, fontWeight: 300, color: seg.n === "X" ? T.coral : T.text1 }}>{seg.n}</span>
              <span style={{ display: "block", fontSize: 10, color: T.text4, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{seg.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontFamily: T.serif, fontSize: 17, fontWeight: 300, fontStyle: "italic", color: T.text1, margin: 0 }}>
          Hold, don&apos;t count reps.
        </p>
      )}
      <p style={{ fontSize: 13, color: T.text2, marginTop: 12, lineHeight: 1.6 }}>{t.principle}</p>
      {t.note && <p style={{ fontSize: 12, color: T.text3, marginTop: 8, lineHeight: 1.6 }}>{t.note}</p>}
      <p style={{ fontSize: 11, color: T.text4, marginTop: 10, lineHeight: 1.6 }}>
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
      { "@type": "ListItem", position: 1, name: "Exercise Library", item: "https://theforged.fit/library" },
      { "@type": "ListItem", position: 2, name: entry.name, item: `https://theforged.fit/library/${entry.slug}` },
    ],
  };

  return (
    <div style={{ minHeight: "100vh", padding: "max(52px, calc(env(safe-area-inset-top, 0px) + 12px)) 24px 64px", maxWidth: 640, margin: "0 auto" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />

      <Link href="/library" style={{ fontSize: 12, color: T.text3, fontFamily: T.sans, textDecoration: "none" }}>
        ← Library
      </Link>

      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
          {entry.categoryLabel}
        </div>
        <h1 style={{ fontFamily: T.serif, fontSize: 38, fontWeight: 300, lineHeight: 1.15, margin: 0 }}>{entry.name}</h1>
        <p style={{ fontSize: 14, color: T.text2, marginTop: 12, lineHeight: 1.6 }}>
          Trains <span style={{ color: T.gold, fontStyle: "italic", fontFamily: T.serif }}>{entry.primary.toLowerCase()}</span> first
          {entry.secondary.length > 0
            ? `, with real work landing on ${entry.secondary.slice(0, 3).map((s) => s.muscle.toLowerCase()).join(", ")}${entry.secondary.length > 3 ? " and more" : ""}.`
            : " — focused, direct, nothing hidden in the movement."}
        </p>
      </div>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>
          Muscle contribution per set
        </h2>
        <MuscleBar muscle={entry.primary} weight={1} primary />
        {entry.secondary.map((s) => (
          <MuscleBar key={s.muscle} muscle={s.muscle} weight={s.weight} />
        ))}
        <p style={{ fontSize: 12, color: T.text3, marginTop: 12, lineHeight: 1.6 }}>
          These are the weights Forge&apos;s volume audit actually computes with — deliberately
          conservative, so compounds don&apos;t masquerade as full coverage. A 0.5 means a set
          counts as half a set for that muscle: meaningful help, not a replacement for direct work.
        </p>
      </section>

      <TempoSection name={entry.name} />

      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>
          How Forge progresses it
        </h2>
        <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, margin: 0 }}>{entry.progression}</p>
      </section>

      {entry.swaps.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h2 style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px" }}>
            Swap it for
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {entry.swaps.map((s) => (
              <li key={s.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "11px 0", borderBottom: `1px solid ${T.bg3}` }}>
                {s.slug ? (
                  <Link href={`/library/${s.slug}`} style={{ fontFamily: T.serif, fontSize: 16, fontWeight: 300, color: T.text1, textDecoration: "none" }}>
                    {s.name}
                  </Link>
                ) : (
                  <span style={{ fontFamily: T.serif, fontSize: 16, fontWeight: 300, color: T.text1 }}>{s.name}</span>
                )}
                <span style={{ fontSize: 11, color: T.text4, fontFamily: T.sans, flexShrink: 0 }}>{s.equipment}</span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: T.text3, marginTop: 12, lineHeight: 1.6 }}>
            Same movement pattern, same progression continuity — these are the alternatives the
            app offers mid-session when a rack is taken or equipment isn&apos;t there.
          </p>
        </section>
      )}

      <p style={{ marginTop: 48, fontSize: 13, color: T.text3, fontFamily: T.serif, fontStyle: "italic", lineHeight: 1.6 }}>
        Train with intention. <Link href="/" style={{ color: T.gold }}>Open Forge</Link> — it prescribes
        the weight, watches the reps, and does this arithmetic for every set you log.
      </p>
    </div>
  );
}
