"use client";

// app/locker-room/page.jsx
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCKER ROOM — Forge's body surface (boss decision 2026-07-21): the Lab
// is what you lift; the Locker Room is what it's doing to you. Bodyweight
// chart UNGATED on top (always metro-safe); photos are a hidden layer behind
// "Show photos" — the toggle IS the auth boundary. Fail-modest every visit:
// photos never render until asked. With the 30-day photo cookie (httpOnly,
// path-scoped) the reveal is usually ZERO-prompt; the ceremony only runs
// when the cookie is absent/expired. "Hide photos" flips back to chart-only
// at any time. Copy: functional drafts — joint intimacy pass pending.
//
// Boss decisions (2026-07-21) built in:
//   - ONE ceremony per visit: tokens ride the in-memory auth session
//     (lib/auth-session); Face ID only when no live token exists.
//   - "Add photo" lives here too, any time — tagged with the most recent
//     bodyweight, then a gentle ask whether to update the weight; declining
//     keeps the latest-known tag.
//   - Until photos exist this page is JUST the bodyweight history chart
//     (sourced from session-record snapshots — the timeline predates the
//     photo feature) with a quiet invitation to add the first photo.
//   - Delete-a-photo (the metro clause): per-photo, behind a confirm,
//     token-gated at the API. Regret must be reversible.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { T } from "@/lib/tokens";
import { P, BW, getLocalProfile, pushNow } from "@/lib/storage";
import { haptic } from "@/lib/a11y";
import { ensurePhotoAccess } from "@/lib/auth-session";
import { preparePhoto, uploadPhoto, deletePhoto, fetchPhotoIndex, fetchPhotoObjectUrl } from "@/lib/photos";
import { todayLocalIso, parseLocalDate } from "@/lib/dates";
import BodyweightDrum from "@/components/BodyweightDrum";

export default function LockerRoom() {
  const router = useRouter();
  // Hydration-safe (#76): SSR renders the empty shell; the first client
  // render matches it (mounted=false), and localStorage-derived content
  // appears after mount. Without the gate, the lazy P.getActive() read made
  // the first client render diverge from the server HTML and React threw
  // away the tree (silent in prod, flagged in dev).
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the canonical two-pass hydration gate; runs once
  useEffect(() => setMounted(true), []);
  const [profile] = useState(() => (typeof window !== "undefined" ? P.getActive() : null));
  const [token, setToken] = useState(null);
  const [shown, setShown] = useState(false); // "Show photos" toggle — fail-modest each visit
  const [photos, setPhotos] = useState(null);
  const [urls, setUrls] = useState({});
  const [pos, setPos] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [askBw, setAskBw] = useState(null); // date just uploaded, awaiting the weight question
  const [bwDraft, setBwDraft] = useState(75);
  const [showDrum, setShowDrum] = useState(false);
  const trackRef = useRef(null);
  const lastSnapRef = useRef(0);
  const urlsRef = useRef({});

  useEffect(() => () => { Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);

  const mintUrl = (tok, date) => {
    fetchPhotoObjectUrl(profile, tok, date).then((u) => {
      if (u) { urlsRef.current[date] = u; setUrls((prev) => ({ ...prev, [date]: u })); }
    });
  };

  const reveal = async () => {
    setBusy(true); setErr(null);
    try {
      // Cookie-first: most visits need no prompt at all.
      const { token: t, result: idx } = await ensurePhotoAccess(profile, (tok) => fetchPhotoIndex(profile, tok));
      if (!idx?.ok) { setErr(idx?.requiresAuth ? "Unlock cancelled." : "Couldn't load your photos."); return; }
      setToken(t);
      setPhotos(idx.photos);
      setPos(Math.max(0, idx.photos.length - 1));
      for (const p of idx.photos) mintUrl(t, p.date);
      setShown(true);
    } finally { setBusy(false); }
  };

  // Add-photo, any time: tag with the most recent known bodyweight, then ask.
  const onPick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !f.type?.startsWith("image/")) return;
    setBusy(true); setErr(null);
    try {
      const blob = await preparePhoto(f);
      if (!blob) { setErr("That image didn't work — try another?"); return; }
      const date = todayLocalIso();
      const latestBw = BW.getKg(profile);
      const res = await uploadPhoto(profile, token, date, blob, { bodyweightAt: latestBw });
      if (!res.ok) { setErr(res.error || "Upload failed."); return; }
      haptic.commit();
      const idx = await fetchPhotoIndex(profile, token);
      if (idx.ok) {
        setPhotos(idx.photos);
        setPos(idx.photos.findIndex((p) => p.date === date));
        mintUrl(token, date);
      }
      setBwDraft(latestBw || 75);
      setAskBw(date); // gentle: "log today's weight too?"
    } finally { setBusy(false); }
  };

  const saveBwAndTag = async () => {
    setBusy(true);
    try {
      BW.set(profile, bwDraft);
      pushNow(profile).catch(() => {});
      // Re-tag today's photo with the fresh number (overwrite-in-place upsert).
      const u = urls[askBw];
      if (u) {
        const blob = await fetch(u).then((r) => r.blob()).catch(() => null);
        if (blob) await uploadPhoto(profile, token, askBw, blob, { bodyweightAt: bwDraft });
      }
      const idx = await fetchPhotoIndex(profile, token);
      if (idx.ok) setPhotos(idx.photos);
      haptic.commit();
    } finally { setAskBw(null); setShowDrum(false); setBusy(false); }
  };

  const doDelete = async () => {
    const cur = photos[Math.round(pos)];
    if (!cur) return;
    setBusy(true); setErr(null);
    try {
      const res = await deletePhoto(profile, token, cur.date);
      if (!res.ok) { setErr(res.error || "Couldn't remove it — try again."); return; }
      if (urls[cur.date]) { URL.revokeObjectURL(urls[cur.date]); delete urlsRef.current[cur.date]; }
      const next = photos.filter((p) => p.date !== cur.date);
      setPhotos(next);
      setPos(Math.max(0, Math.min(Math.round(pos), next.length - 1)));
      haptic.commit();
    } finally { setConfirmDelete(false); setBusy(false); }
  };

  const posFromClientX = (clientX) => {
    const el = trackRef.current;
    if (!el || !photos?.length) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (photos.length - 1);
  };
  const onDrag = (e) => {
    if (e.buttons === 0 && e.type === "pointermove") return;
    const p = posFromClientX(e.clientX);
    setPos(p);
    const snap = Math.round(p);
    if (snap !== lastSnapRef.current) { lastSnapRef.current = snap; haptic.settle(); }
  };

  // ── Shared bits ─────────────────────────────────────────────────────────
  // Shell-compliant (Phase 2 contract, .forge-page owns the viewport): no
  // vh/dvh, no safe-area math, no local background — the substrate runs
  // continuous under the status bar; this page only adds design spacing.
  const page = { color: T.text1, fontFamily: T.sans, padding: "20px 20px 24px" };
  const serif = { fontFamily: T.serif, fontWeight: 300 };
  const coralBtn = { padding: "14px 20px", background: T.coral, border: "none", borderRadius: T.r.lg, ...serif, fontSize: 16, color: T.bg0, cursor: "pointer" };
  const quietBtn = { padding: "10px 14px", background: "none", border: "none", fontSize: 12, color: T.text3, cursor: "pointer" };
  const PICK_ID = "scrub-photo-input";
  const picker = <input id={PICK_ID} type="file" accept="image/*" onChange={onPick} style={{ display: "none" }} />;

  // Bodyweight chart data, three sources in rising precedence: session-record
  // snapshots (retro coverage — the timeline predates the journal), photo
  // tags, then THE JOURNAL (boss, 2026-07-24) — every BW.set stamps a
  // date-keyed entry, so logging weight populates this page immediately,
  // no photos or sessions required. Journal wins overlaps: it IS the scale
  // reading; the other two are derived echoes of it.
  const bwSeries = (() => {
    if (!profile) return [];
    const seen = new Map();
    for (const rec of getLocalProfile(profile).history) {
      if (rec?.date && rec.bodyweight != null) seen.set(rec.date, rec.bodyweight);
    }
    for (const p of photos || []) if (p.bodyweightAt != null) seen.set(p.date, p.bodyweightAt);
    for (const [date, e] of Object.entries(BW.getLogRaw(profile))) {
      if (e?.kg != null) seen.set(date, e.kg);
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, kg]) => ({ date, kg }));
  })();

  const bwChart = (h = 120) => {
    if (bwSeries.length === 0) return <p style={{ fontSize: 12, color: T.text4 }}>Log a bodyweight and your story starts here.</p>;
    if (bwSeries.length === 1) {
      // The very first log must visibly LAND (boss, 2026-07-24) — one point
      // renders as a marked reading, not placeholder copy.
      const only = bwSeries[0];
      return (
        <div style={{ height: h, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: T.sage, alignSelf: "center" }} />
            <span style={{ ...serif, fontSize: 28 }}>{only.kg} kg</span>
            <span style={{ fontSize: 11, color: T.text4, letterSpacing: "0.08em" }}>{only.date}</span>
          </div>
          <p style={{ fontSize: 12, color: T.text4, marginTop: 8 }}>First point on the curve — the next one draws the line.</p>
        </div>
      );
    }
    // Multi-point (boss, 2026-07-26: "this line means nothing without either
    // a scale or specific numbering"): numbering chosen over axes — the
    // house chart language stays gridless, and the numbers do the work.
    // Anatomy mirrors the Lab's 1RM chart: current reading + delta above,
    // values ON the points while they're few enough to read (≤6; endpoints
    // only beyond that), dates anchoring the ends.
    const w = 340, PAD_X = 14, PAD_TOP = 16, PAD_BOT = 6;
    const n = bwSeries.length;
    const ks = bwSeries.map((d) => d.kg);
    const kMin = Math.min(...ks), kMax = Math.max(...ks);
    const pts = bwSeries.map((d, i) => ({
      ...d,
      x: PAD_X + (i / (n - 1)) * (w - 2 * PAD_X),
      y: kMax === kMin ? h / 2 : PAD_TOP + (1 - (d.kg - kMin) / (kMax - kMin)) * (h - PAD_TOP - PAD_BOT - 12),
    }));
    const first = bwSeries[0], last = bwSeries[n - 1];
    const delta = Math.round((last.kg - first.kg) * 10) / 10;
    const fmtD = (iso) => parseLocalDate(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const labelled = n <= 6 ? pts : [pts[0], pts[n - 1]];
    return (
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "2px 0 6px" }}>
          <span style={{ ...serif, fontSize: 26 }}>{last.kg} kg</span>
          {delta !== 0 && (
            <span style={{ fontFamily: T.serif, fontSize: 12, fontStyle: "italic", color: delta < 0 ? T.sage : T.text3 }}>
              {delta > 0 ? "+" : "−"}{Math.abs(delta)} kg since {fmtD(first.date)}
            </span>
          )}
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block" }}>
          <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={T.sage} strokeWidth="1.5" opacity="0.8" />
          {pts.map((p, i) => (
            <circle key={p.date} cx={p.x} cy={p.y} r={i === n - 1 ? 3 : 2.5} fill={i === n - 1 ? T.coral : T.sage} />
          ))}
          {labelled.map((p) => (
            <text key={`t${p.date}`} x={p.x} y={p.y < PAD_TOP + 10 ? p.y + 16 : p.y - 8}
              textAnchor={p.x < 30 ? "start" : p.x > w - 30 ? "end" : "middle"}
              style={{ fontSize: 10, fontFamily: T.sans, fill: p.date === last.date ? T.text2 : T.text3 }}>
              {p.kg}
            </text>
          ))}
        </svg>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: T.text4 }}>{fmtD(first.date)}</span>
          <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: T.text4 }}>{fmtD(last.date)}</span>
        </div>
      </div>
    );
  };

  if (!profile) return <main style={page}><p style={{ color: T.text3 }}>No active profile — sign in first, then come back to the Locker Room.</p></main>;

  // ── Chart-first layout: ungated bodyweight on top, photos behind the toggle ──
  const photosVisible = shown && photos !== null;
  const cur = photosVisible && photos.length ? photos[Math.round(pos)] : null;
  const i0 = photosVisible && photos.length ? Math.floor(pos) : 0;
  const i1 = photosVisible && photos.length ? Math.min(photos.length - 1, i0 + 1) : 0;
  const frac = pos - i0;
  const weights = (photos || []).map((p) => p.bodyweightAt).filter((w) => w != null);
  const wMin = weights.length ? Math.min(...weights) : 0, wMax = weights.length ? Math.max(...weights) : 1;
  const curveW = 320, curveH = 56;
  const pts = (photos || []).map((p, i) => {
    const x = photos.length === 1 ? curveW / 2 : (i / (photos.length - 1)) * curveW;
    const y = p.bodyweightAt == null || wMax === wMin ? curveH / 2 : curveH - ((p.bodyweightAt - wMin) / (wMax - wMin)) * (curveH - 8) - 4;
    return { x, y };
  });
  const markerX = !photos?.length ? 0 : photos.length === 1 ? curveW / 2 : (pos / (photos.length - 1)) * curveW;

  return (
    <main style={page}>
      {picker}
      {/* Header anatomy mirrors the Performance Lab (#73c/d): safe-area-aware
          back-nav row with the photos toggle right-aligned, then eyebrow +
          serif headline. Lab is gold; the Locker Room is sage — same bones,
          its own light. */}
      {/* No self-clearance: .forge-page owns the status bar (Phase 2 shell
          contract — the ratchet rejects new safe-area-inset padding here,
          unlike the Lab's grandfathered header). Design spacing only. */}
      <div style={{ padding: "32px 0 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={() => router.push("/")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, color: T.text3, fontFamily: T.sans }}>
          ← Home
        </button>
        {photosVisible ? (
          <button onClick={() => setShown(false)} style={{ padding: "8px 14px", background: T.bg3, border: `1px solid ${T.bg4}`, borderRadius: T.r.md, fontSize: 12, color: T.text2, cursor: "pointer" }}>Hide photos</button>
        ) : (
          <button onClick={reveal} disabled={busy} style={{ padding: "8px 14px", background: T.bg3, border: `1px solid ${T.bg4}`, borderRadius: T.r.md, fontSize: 12, color: T.text2, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "One sec…" : "Show photos"}</button>
        )}
      </div>
      <div style={{ padding: "24px 0 0" }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
          Locker room
        </div>
        <div className="home-headline" style={{ fontFamily: T.serif, fontSize: 42, fontWeight: 300, lineHeight: 1.1, transformOrigin: "left top" }}>
          Your<br/><span style={{ color: T.sage, fontStyle: "italic" }}>story.</span>
        </div>
        <p style={{ fontSize: 14, color: T.text2, margin: "10px 0 16px", lineHeight: 1.5 }}>The chart is always here; photos stay behind the door until you ask.</p>
      </div>

      {/* The always-on bodyweight chart */}
      {bwChart(photosVisible ? 90 : 150)}
      {err && <p style={{ fontSize: 12, color: T.rose, marginTop: 10 }}>{err}</p>}

      {photosVisible && photos.length === 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 13, color: T.text3, marginBottom: 12 }}>No photos yet — the timeline starts with one.</p>
          <label htmlFor={PICK_ID} role="button" style={{ ...coralBtn, display: "inline-block" }}>Add your first photo</label>
        </div>
      )}

      {photosVisible && photos.length > 0 && (<>
        {/* The old OLDEST/MOST-RECENT row died when the chart grew its own
            date anchors (2026-07-26) — saying it twice was the opposite of
            elegant. */}
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0 10px" }}>
          <label htmlFor={PICK_ID} role="button" style={{ padding: "8px 14px", background: T.bg3, border: `1px solid ${T.bg4}`, borderRadius: T.r.md, fontSize: 12, color: T.text2, cursor: "pointer" }}>+ Add photo</label>
        </div>

        {askBw && (
          <div style={{ marginBottom: 14, padding: "12px 14px", borderRadius: T.r.md, background: `${T.sage}12`, border: `1px solid ${T.sage}33` }}>
            {showDrum ? (<>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><BodyweightDrum value={bwDraft} onChange={setBwDraft} /></div>
              <button onClick={saveBwAndTag} disabled={busy} style={{ ...coralBtn, width: "100%" }}>{busy ? "Saving…" : "Save weight"}</button>
            </>) : (<>
              <span style={{ fontSize: 13, color: T.text1 }}>Photo saved. Update your bodyweight too?</span>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={() => setShowDrum(true)} style={{ ...coralBtn, padding: "10px 16px", fontSize: 14 }}>Update it</button>
                <button onClick={() => setAskBw(null)} style={quietBtn}>Keep {photos.find((p) => p.date === askBw)?.bodyweightAt ?? "latest"} kg</button>
              </div>
            </>)}
          </div>
        )}

        <div ref={trackRef} onPointerDown={onDrag} onPointerMove={onDrag}
          style={{ position: "relative", width: "100%", aspectRatio: "3/4", maxHeight: "46dvh", borderRadius: T.r.xl, overflow: "hidden", background: T.bg2, touchAction: "pan-y", marginBottom: 12 }}>
          {urls[photos[i0].date] && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={urls[photos[i0].date]} alt={photos[i0].date} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 1 - frac }} />
          )}
          {i1 !== i0 && urls[photos[i1].date] && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={urls[photos[i1].date]} alt={photos[i1].date} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: frac }} />
          )}
          <div style={{ position: "absolute", left: 12, bottom: 12, padding: "8px 12px", borderRadius: T.r.md, background: `${T.bg0}CC`, backdropFilter: "blur(8px)" }}>
            <div style={{ ...serif, fontSize: 18 }}>{cur?.bodyweightAt != null ? `${cur.bodyweightAt} kg` : "—"}</div>
            <div style={{ fontSize: 10, color: T.text3, letterSpacing: "0.08em" }}>{cur?.date}</div>
          </div>
        </div>

        <div onPointerDown={onDrag} onPointerMove={onDrag} style={{ touchAction: "pan-y" }}>
          <svg viewBox={`0 0 ${curveW} ${curveH}`} style={{ width: "100%", height: curveH, display: "block" }}>
            <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={T.sage} strokeWidth="1.5" opacity="0.7" />
            {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={Math.round(pos) === i ? T.coral : T.bg4} />)}
            <line x1={markerX} y1="0" x2={markerX} y2={curveH} stroke={T.coral} strokeWidth="1" opacity="0.8" />
          </svg>
        </div>

        <div style={{ marginTop: 10 }}>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: T.rose }}>Remove {cur?.date} for good?</span>
              <button onClick={doDelete} disabled={busy} style={{ padding: "8px 14px", background: `${T.rose}18`, border: `1px solid ${T.rose}55`, borderRadius: T.r.md, fontSize: 12, color: T.rose, cursor: "pointer" }}>{busy ? "Removing…" : "Remove"}</button>
              <button onClick={() => setConfirmDelete(false)} style={quietBtn}>Keep it</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={quietBtn}>Remove this photo</button>
          )}
        </div>
      </>)}
    </main>
  );
}
