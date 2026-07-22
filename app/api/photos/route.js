import { NextResponse } from "next/server";
import { put, get, list, del } from "@vercel/blob";
import crypto from "crypto";
import { isTokenValid, readTokenData } from "@/lib/auth-server";
import { hasDb, dbUpsertPhoto, dbListPhotos, dbDeletePhoto } from "@/lib/db";
import { isJpegBytes, PHOTO_MAX_UPLOAD_BYTES } from "@/lib/photos";

// Progress photos (P1) — the ONE gated data surface in Forge.
// Every verb requires a live authToken (minted by login-verify after a real
// passkey ceremony) in the X-HW-Auth HEADER — never a query param, per
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

// Sliding 7-day cookie window (boss call, 2026-07-21): a secure device that
// keeps being used never re-auths — any active day past ROTATE_AFTER mints a
// fresh 7-day token and silently re-sets the cookie. A device that goes
// QUIET dies in 7 days (tighter than the old fixed 30 for lost phones), and
// rotation bounds any single token's life. Old records lapse naturally —
// never deleted mid-flight, so a lost Set-Cookie can't strand the user;
// expired token blobs are inert (checked at read), same posture as legacy
// suffixed orphans.
const PHOTO_TTL_MS = 7 * 86400000;
const ROTATE_AFTER_MS = 86400000; // any active day slides the window
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "strict", path: "/api/photos", maxAge: 7 * 86400 };

// Attach a rotated cookie (if the gate minted one) to any success response.
const withCookie = (res, g) => {
  if (g.refresh) res.cookies.set("hw_photos", g.refresh, COOKIE_OPTS);
  return res;
};

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
  // Header token (fresh ceremony) OR the sliding photo-scope cookie —
  // httpOnly + path-scoped to this route, set by login-verify. Cookie means
  // the phone the user unlocked stays unlocked; the wipe never accepts it.
  const headerToken = request.headers.get("x-hw-auth") || null;
  const cookieToken = request.cookies.get("hw_photos")?.value || null;
  const token = headerToken || cookieToken;
  const data = await readTokenData(token);
  if (!isTokenValid(data, profile, Date.now())) {
    return { fail: NextResponse.json({ error: "Passkey authentication required", requiresAuth: true }, { status: 401 }) };
  }
  // Sliding rotation — cookie-carried photo-scope tokens only.
  let refresh = null;
  if (data.scope === "photos" && token === cookieToken) {
    const age = Date.now() - new Date(data.createdAt || 0).getTime();
    if (!Number.isFinite(age) || age > ROTATE_AFTER_MS) {
      refresh = crypto.randomBytes(32).toString("base64url");
      await put(`forge/tokens/${refresh}`, JSON.stringify({
        profile: normalise(profile),
        expires: Date.now() + PHOTO_TTL_MS,
        scope: "photos",
        createdAt: new Date().toISOString(),
      }), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
    }
  }
  return { profile: normalise(profile), date, url, refresh };
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
    return withCookie(NextResponse.json({ ok: true, date: g.date }), g);
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
      return withCookie(NextResponse.json({
        photos: rows.map((r) => ({ date: r.date, bodyweightAt: r.bodyweight_at, takenAt: r.taken_at })),
      }), g);
    }

    const result = await get(photoPath(g.profile, g.date), { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return withCookie(new NextResponse(result.stream, {
      headers: {
        "Content-Type": "image/jpeg",
        // Private per-user media: browser may cache, shared caches must not.
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
      },
    }), g);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DESTRUCTIVE — announced (2026-07-21), the metro clause: remove ONE photo.
// User-initiated from the scrubber behind a confirm, token-gated like every
// verb here, scoped to a single (profile, date): the blob at the
// deterministic path + its index row. Enumerated target, no glob, nothing
// else in the namespace is touchable from this handler.
export async function DELETE(request) {
  try {
    const g = await gate(request);
    if (g.fail) return g.fail;
    if (!g.date) return NextResponse.json({ error: "Date required" }, { status: 400 });

    const path = photoPath(g.profile, g.date);
    // Index row FIRST (same asymmetry as the profile wipe): a surviving blob
    // with no index row is invisible and overwritable; a surviving index row
    // with no blob would 404 in the scrubber forever.
    await dbDeletePhoto(g.profile, g.date);
    try {
      const { blobs } = await list({ prefix: path });
      const exact = blobs.filter((b) => b.pathname === path);
      if (exact.length) await del(exact.map((b) => b.url));
    } catch (e) {
      return NextResponse.json({ error: `Photo removed from index; blob delete failed: ${e.message}` }, { status: 500 });
    }
    return withCookie(NextResponse.json({ ok: true, deleted: g.date }), g);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
