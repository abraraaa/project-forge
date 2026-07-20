"use client";

// app/diag-scrub/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Photos P3 — the progress-photo scrubber, PROTOTYPE (house pattern: diag
// route first; nothing ships to the Lab until the boss's device taste pass).
//
// The idea: "oldest" and "most recent" as bookends, an invitation to explore
// the span between. Thumb-drag across the date axis; the photo CROSSFADES
// under the finger (fractional index → two stacked imgs, opacity = frac);
// the bodyweight curve rides above with a marker tracking the thumb; settle
// haptic on each entry snap.
//
// Privacy: same contract as everywhere — photos unlock with the passkey
// ceremony (one "Unlock" tap → Face ID → token), object URLs are minted
// per-date, cached for the visit, revoked on unload. Nothing here bypasses
// /api/photos' gate.
//
// Safari 27 flair (progressive): the ambition is scroll-driven crossfade via
// animation-timeline once this graduates to the Lab. The prototype keeps the
// core in pointer math (works everywhere, incl. dev) and uses a CSS
// scroll-timeline ONLY for the top progress hairline where supported —
// enough to judge whether the native-driven feel is worth the migration.
//
// COPY: prototype strings only — the real pass happens at Lab graduation.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { T } from "@/lib/tokens";
import { P } from "@/lib/storage";
import { haptic } from "@/lib/a11y";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchPhotoIndex, fetchPhotoObjectUrl } from "@/lib/photos";

export default function DiagScrub() {
  // Lazy init with SSR guard — same pattern as ForgeApp's activeProfile.
  const [profile] = useState(() => (typeof window !== "undefined" ? P.getActive() : null));
  const [token, setToken] = useState(null);
  const [photos, setPhotos] = useState(null); // [{date, bodyweightAt}]
  const [urls, setUrls] = useState({});       // date -> objectURL
  const [pos, setPos] = useState(0);          // fractional index 0..n-1
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const trackRef = useRef(null);
  const lastSnapRef = useRef(0);
  const urlsRef = useRef({});

  // Revoke every minted URL on unload only — during the visit they're the cache.
  useEffect(() => () => { Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);

  const unlock = async () => {
    setBusy(true); setErr(null);
    try {
      const auth = await authenticatePasskey(profile);
      if (!auth?.verified || !auth?.authToken) { setErr("Unlock cancelled."); return; }
      setToken(auth.authToken);
      const idx = await fetchPhotoIndex(profile, auth.authToken);
      if (!idx.ok) { setErr("Couldn't load the photo index."); return; }
      setPhotos(idx.photos);
      setPos(Math.max(0, idx.photos.length - 1)); // land on most recent
      // Warm all URLs up front — prototype scale (weekly cadence) makes this
      // fine; Lab graduation would window it.
      for (const p of idx.photos) {
        fetchPhotoObjectUrl(profile, auth.authToken, p.date).then((u) => {
          if (u) { urlsRef.current[p.date] = u; setUrls((prev) => ({ ...prev, [p.date]: u })); }
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const posFromClientX = (clientX) => {
    const el = trackRef.current;
    if (!el || !photos?.length) return 0;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return frac * (photos.length - 1);
  };
  const onDrag = (e) => {
    if (e.buttons === 0 && e.type === "pointermove") return;
    const p = posFromClientX(e.clientX);
    setPos(p);
    const snap = Math.round(p);
    if (snap !== lastSnapRef.current) { lastSnapRef.current = snap; haptic.settle(); }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  const page = { minHeight: "100dvh", background: T.bg0, color: T.text1, fontFamily: T.sans, padding: "calc(20px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom))" };
  const serif = { fontFamily: T.serif, fontWeight: 300 };

  if (!profile) return <main style={page}><p style={{ color: T.text3 }}>No active profile — sign in first, then revisit /diag-scrub.</p></main>;

  if (!photos) {
    return (
      <main style={page}>
        <h1 style={{ ...serif, fontSize: 26, marginBottom: 6 }}>Progress — prototype</h1>
        <p style={{ fontSize: 13, color: T.text3, maxWidth: 320, lineHeight: 1.6, marginBottom: 24 }}>
          Your photos are locked to your passkey. Unlock to explore the timeline.
        </p>
        {err && <p style={{ fontSize: 12, color: T.rose, marginBottom: 12 }}>{err}</p>}
        <button onClick={unlock} disabled={busy} style={{ padding: "16px 22px", background: T.coral, border: "none", borderRadius: T.r.lg, ...serif, fontSize: 17, color: T.bg0, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Unlocking…" : "Unlock with passkey"}
        </button>
      </main>
    );
  }

  if (photos.length === 0) {
    return <main style={page}><h1 style={{ ...serif, fontSize: 26 }}>Nothing here yet</h1><p style={{ fontSize: 13, color: T.text3, marginTop: 8, maxWidth: 300, lineHeight: 1.6 }}>Add your first photo the next time you log your weight — the timeline starts with one.</p></main>;
  }

  const i0 = Math.floor(pos);
  const i1 = Math.min(photos.length - 1, i0 + 1);
  const frac = pos - i0;
  const cur = photos[Math.round(pos)];
  const weights = photos.map((p) => p.bodyweightAt).filter((w) => w != null);
  const wMin = Math.min(...weights), wMax = Math.max(...weights);
  const curveW = 320, curveH = 56;
  const pts = photos.map((p, i) => {
    const x = photos.length === 1 ? curveW / 2 : (i / (photos.length - 1)) * curveW;
    const y = p.bodyweightAt == null || wMax === wMin ? curveH / 2 : curveH - ((p.bodyweightAt - wMin) / (wMax - wMin)) * (curveH - 8) - 4;
    return { x, y };
  });
  const markerX = photos.length === 1 ? curveW / 2 : (pos / (photos.length - 1)) * curveW;

  return (
    <main style={page}>
      {/* Bookends + invitation (copy pass at Lab graduation) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text4 }}>Oldest · {photos[0].date}</span>
        <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: T.text4 }}>Most recent · {photos[photos.length - 1].date}</span>
      </div>
      <h1 style={{ ...serif, fontSize: 22, marginBottom: 14 }}>Explore the span</h1>

      {/* Photo stage — two stacked imgs, opacity crossfade under the finger */}
      <div
        ref={trackRef}
        onPointerDown={onDrag} onPointerMove={onDrag}
        style={{ position: "relative", width: "100%", aspectRatio: "3/4", maxHeight: "52dvh", borderRadius: T.r.xl, overflow: "hidden", background: T.bg2, touchAction: "none", marginBottom: 14 }}
      >
        {urls[photos[i0].date] && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={urls[photos[i0].date]} alt={photos[i0].date} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 1 - frac }} />
        )}
        {i1 !== i0 && urls[photos[i1].date] && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={urls[photos[i1].date]} alt={photos[i1].date} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: frac }} />
        )}
        {/* Readout chip */}
        <div style={{ position: "absolute", left: 12, bottom: 12, padding: "8px 12px", borderRadius: T.r.md, background: `${T.bg0}CC`, backdropFilter: "blur(8px)" }}>
          <div style={{ ...serif, fontSize: 18 }}>{cur?.bodyweightAt != null ? `${cur.bodyweightAt} kg` : "—"}</div>
          <div style={{ fontSize: 10, color: T.text3, letterSpacing: "0.08em" }}>{cur?.date}</div>
        </div>
      </div>

      {/* Bodyweight curve + thumb marker (drag here too) */}
      <div onPointerDown={onDrag} onPointerMove={onDrag} style={{ touchAction: "none", padding: "4px 0 0" }}>
        <svg viewBox={`0 0 ${curveW} ${curveH}`} style={{ width: "100%", height: curveH, display: "block" }}>
          <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={T.sage} strokeWidth="1.5" opacity="0.7" />
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={Math.round(pos) === i ? T.coral : T.bg4} />)}
          <line x1={markerX} y1="0" x2={markerX} y2={curveH} stroke={T.coral} strokeWidth="1" opacity="0.8" />
        </svg>
      </div>
      <p style={{ fontSize: 11, color: T.text4, marginTop: 10, lineHeight: 1.5 }}>
        Drag anywhere on the photo or the curve. Prototype only — taste pass pending before this touches the Lab.
      </p>
    </main>
  );
}
