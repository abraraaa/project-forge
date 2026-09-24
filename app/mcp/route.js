import { rateLimit } from "@/lib/rate-limit";
import { verifyAccessToken } from "@/lib/oauth";
import { neonOAuthStore } from "@/lib/oauth-store";
import { credentialExists } from "@/lib/oauth-credentials";
import { handleMcp } from "@/lib/mcp-server";
import { dbReadProfile } from "@/lib/db";
import { ISSUER } from "@/lib/oauth-http";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// /mcp — Streamable HTTP, stateless, JSON responses only (no SSE stream).
// Bearer token from /oauth/token; the token names the profile. Read only.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200, extra = {}) =>
  new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body == null ? {} : { "Content-Type": "application/json" }), "Cache-Control": "no-store", ...CORS, ...extra },
  });

// An AI often fires several tool calls in a burst. One profile read serves
// them all for 30s (per connection; Fluid compute keeps the instance warm).
const CACHE_MS = 30_000;
const cache = new Map();
function readCached(key, read) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = read();
  cache.set(key, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  value.catch(() => cache.delete(key));
  return value;
}

const unauthorized = () => json({ error: "invalid_token" }, 401, {
  "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
});

export async function POST(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return unauthorized();

  const store = await neonOAuthStore();
  if (!store) return json({ error: "temporarily_unavailable" }, 503);
  const who = await verifyAccessToken(store, token, { credentialExists });
  if (!who) return unauthorized();

  // Per connection, not just per IP: one AI can't hammer the database.
  const limited = rateLimit(request, `mcp:${who.grantId}`, 60);
  if (limited) return limited;

  const msg = await request.json().catch(() => undefined);
  if (msg === undefined) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);

  const load = () => readCached(who.grantId, () => dbReadProfile(who.profile));
  const res = await handleMcp(msg, { load });
  return res === null ? json(null, 202) : json(res);
}

// No server-initiated stream: this server never pushes.
export function GET() { return json(null, 405, { Allow: "POST, OPTIONS" }); }
export function OPTIONS() { return json(null, 204); }
