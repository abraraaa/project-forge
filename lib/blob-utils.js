// @ts-check
// lib/blob-utils.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared Vercel Blob reading utilities for API routes.
// Centralises the pattern of reading private JSON blobs.
// ─────────────────────────────────────────────────────────────────────────────

import { get, list, del } from "@vercel/blob";

/**
 * Read JSON directly by exact pathname (for blobs without random suffix like challenges).
 * Returns parsed JSON or null on failure.
 */
export async function readJsonDirect(pathname) {
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

/**
 * Read JSON from private blob using list() + get() (for blobs with random suffix).
 * Returns the latest blob's parsed JSON, or null if not found.
 * @param {string} prefix
 * @returns {Promise<object|null>}
 */
export async function readJsonByPrefix(prefix) {
  try {
    const { blobs } = await list({ prefix });
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0];
    return await readJsonDirect(latest.pathname);
  } catch {
    return null;
  }
}

/**
 * Delete all blobs matching a prefix (for cleanup).
 * Silently ignores errors.
 */
export async function deleteByPrefix(prefix) {
  try {
    const { blobs } = await list({ prefix });
    if (blobs.length) {
      await del(blobs.map(b => b.url));
    }
    return blobs.length;
  } catch {
    return 0;
  }
}
