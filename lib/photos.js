// @ts-check
// lib/photos.js
// ─────────────────────────────────────────────────────────────────────────────
// Progress-photo client pipeline (Photos P1 — design settled with the boss,
// 2026-07-20). Quality over thrift: ~2048px long edge at JPEG ~0.85
// (~400–800KB) so zoomed detail survives; storage math is trivial at weekly
// cadence. The canvas re-encode strips ALL metadata (EXIF/GPS) by
// construction — createImageBitmap applies the EXIF orientation to the
// PIXELS first, so uprightness survives the strip. A future opt-in
// "where you've been" captures location explicitly at upload time instead
// of retaining EXIF.
//
// Privacy contract: photos are passkey-territory. Every request carries a
// short-lived authToken minted by login-verify; there is no open-read path
// (the #20/#21 open-reads decision's revisit trigger, honoured).
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout, UPLOAD_TIMEOUT_MS } from "./net.js";

export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_JPEG_QUALITY = 0.85;
export const PHOTO_MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // safety ceiling, not a target

/**
 * Pure: target dimensions for a downscale to `maxEdge` on the LONG edge.
 * Never upscales. Preserves aspect ratio, rounds to integers.
 */
export function computeTargetDims(width, height, maxEdge = PHOTO_MAX_EDGE) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Pure: JPEG magic-byte check (SOI marker FF D8 FF). */
export function isJpegBytes(bytes) {
  return !!bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Downscale + re-encode a captured image file to a clean JPEG Blob.
 * Returns null if the input can't be decoded (caller shows a soft error).
 */
export async function preparePhoto(file) {
  try {
    // imageOrientation:"from-image" bakes EXIF rotation into the pixels
    // BEFORE we strip metadata — otherwise iPhone portraits land sideways.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = computeTargetDims(bitmap.width, bitmap.height);
    if (!width) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY),
    );
    if (!blob || blob.size > PHOTO_MAX_UPLOAD_BYTES) return null;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Upload a prepared JPEG for a LOCAL calendar date (lib/dates doctrine).
 * Returns { ok, date } or { ok:false, error, requiresAuth? }.
 */
export async function uploadPhoto(profile, authToken, date, blob, { bodyweightAt = null } = {}) {
  try {
    const params = new URLSearchParams({ profile, date });
    if (bodyweightAt != null) params.set("bw", String(bodyweightAt));
    const res = await fetchWithTimeout(`/api/photos?${params}`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "X-HW-Auth": authToken || "" },
      body: blob,
    }, UPLOAD_TIMEOUT_MS);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `Upload failed (${res.status})`, requiresAuth: res.status === 401 };
    return { ok: true, date: body.date };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
}

/** Photo index (dates + bodyweight overlay data), oldest first. */
export async function fetchPhotoIndex(profile, authToken) {
  try {
    const res = await fetchWithTimeout(`/api/photos?profile=${encodeURIComponent(profile)}`, {
      headers: { "X-HW-Auth": authToken || "" },
    });
    if (!res.ok) return { ok: false, requiresAuth: res.status === 401 };
    const body = await res.json();
    return { ok: true, photos: body.photos || [] };
  } catch {
    return { ok: false };
  }
}

/** One photo's bytes as an object URL (caller revokes). */
export async function fetchPhotoObjectUrl(profile, authToken, date) {
  try {
    const res = await fetchWithTimeout(`/api/photos?profile=${encodeURIComponent(profile)}&date=${encodeURIComponent(date)}`, {
      headers: { "X-HW-Auth": authToken || "" },
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/** DESTRUCTIVE (the metro clause): remove one photo. Caller confirms first. */
export async function deletePhoto(profile, authToken, date) {
  try {
    const res = await fetchWithTimeout(`/api/photos?profile=${encodeURIComponent(profile)}&date=${encodeURIComponent(date)}`, {
      method: "DELETE",
      headers: { "X-HW-Auth": authToken || "" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error, requiresAuth: res.status === 401 };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
  }
}
