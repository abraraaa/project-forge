import { NextResponse } from "next/server";
import { put, get } from "@vercel/blob";
import { verifyAuthToken } from "@/lib/auth-server";
import { hasDb, dbUpsertPhoto, dbListPhotos } from "@/lib/db";
import { isJpegBytes, PHOTO_MAX_UPLOAD_BYTES } from "@/lib/photos";

// Progress photos (P1) — the ONE gated data surface in Forge.
// Every verb requires a live authToken (minted by login-verify after a real
// passkey ceremony) in the X-Forge-Auth HEADER — never a query param, per
// house law: keys don't ride URLs. Tokens are verified WITHOUT consuming
// (the wipe path owns consumption). There is no open-read here and must
// never be: physique photos are the revisit trigger the open-reads decision
// (#20/#21) named. EXIF never reaches this route — the client re-encode
// strips it; we still validate magic bytes + size server-side.
//
//   POST /api/photos?profile=N&date=YYYY-MM-DD[&bw=76.2]   body: image/jpeg
//   GET  /api/photos?profile=N                -> { photos: [{date, bodyweightAt, takenAt}] }
//   GET  /api/photos?profile=N&date=...       -> image/jpeg bytes

const normalise = (name) => String(name || "").trim().toLowerCase();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same character rules as validateProfile in the sync route: control chars
// and path separators are rejected; spaces/hyphens are legal profile names.
// Expressed via code points (not regex escapes) to keep this file free of
// unusual literals.
function isBadProfileName(name) {
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 64) return true;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127 || ch === "/" || ch === "\\") return true;
  }
  return false;
}

// Deterministic, overwrite-in-place (house pattern): one photo per local day.
const photoPath = (profile, date) =>
  `forge/profiles/${encodeURIComponent(normalise(profile))}/photos/${date}.jpg`;

async function gate(request) {
  const url = new URL(request.url);
  const profile = url.searchParams.get("profile");
  const date = url.searchParams.get("date");
  if (isBadProfileName(profile)) {
    return { fail: NextResponse.json({ error: "Invalid profile" }, { status: 400 }) };
  }
  if (date !== null && !DATE_RE.test(date)) {
    return { fail: NextResponse.json({ error: "Invalid date" }, { status: 400 }) };
  }
  const token = request.headers.get("x-forge-auth");
  if (!(await verifyAuthToken(profile, token))) {
    return { fail: NextResponse.json({ error: "Passkey authentication required", requiresAuth: true }, { status: 401 }) };
  }
  return { profile: normalise(profile), date, url };
}

export async function POST(request) {
  try {
    const g = await gate(request);
    if (g.fail) return g.fail;
    if (!g.date) return NextResponse.json({ error: "Date required" }, { status: 400 });
    if (!hasDb()) return NextResponse.json({ error: "Photo index unavailable" }, { status: 503 });

    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length === 0 || buf.length > PHOTO_MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Image missing or too large" }, { status: 413 });
    }
    if (!isJpegBytes(buf)) {
      return NextResponse.json({ error: "Not a JPEG" }, { status: 415 });
    }

    const bwRaw = g.url.searchParams.get("bw");
    const bodyweightAt = bwRaw !== null && Number.isFinite(Number(bwRaw)) ? Number(bwRaw) : null;

    const path = photoPath(g.profile, g.date);
    await put(path, buf, {
      access: "private",
      contentType: "image/jpeg",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    await dbUpsertPhoto(g.profile, { date: g.date, blobPath: path, bodyweightAt });
    return NextResponse.json({ ok: true, date: g.date });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const g = await gate(request);
    if (g.fail) return g.fail;

    if (g.date === null) {
      // Index — blob paths stay server-side.
      const rows = await dbListPhotos(g.profile);
      return NextResponse.json({
        photos: rows.map((r) => ({ date: r.date, bodyweightAt: r.bodyweight_at, takenAt: r.taken_at })),
      });
    }

    const result = await get(photoPath(g.profile, g.date), { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": "image/jpeg",
        // Private per-user media: browser may cache, shared caches must not.
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
