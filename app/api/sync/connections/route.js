import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, isTokenValid } from "@/lib/auth-server";
import { neonOAuthStore } from "@/lib/oauth-store";
import { revokeGrantFor } from "@/lib/oauth";
import { normaliseProfile } from "@/lib/profile-name";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// Connected AIs for a profile — list and disconnect. Lives under /api/sync so
// the hw_sync cookie (path-scoped there) authorises it: whoever may read the
// training record may see and end who else reads it. Disconnect stamps
// revoked_at; nothing is deleted.
//   GET  /api/sync/connections?profile=N                 -> { connections: [...] }
//   POST /api/sync/connections  { profile, disconnect }  -> { ok }

async function gate(request, profile) {
  const header = request.headers.get("x-hw-auth") || null;
  const cookie = request.cookies.get("hw_sync")?.value || null;
  const data = await readTokenData(header || cookie);
  if (!isTokenValid(data, profile, Date.now())) return false;
  // Full-scope ceremony token, or the sync-scope cookie. Never photos.
  return !data.scope || data.scope === "sync";
}

const denied = () => NextResponse.json({ error: "Sign in to manage connections", requiresAuth: true }, { status: 401 });

export async function GET(request) {
  const limited = rateLimit(request, "connections-read", 30);
  if (limited) return limited;
  try {
    const profile = new URL(request.url).searchParams.get("profile") || "";
    if (!profile || !(await gate(request, profile))) return denied();
    const store = await neonOAuthStore();
    if (!store) return NextResponse.json({ connections: [] });
    const rows = await store.listGrants(normaliseProfile(profile));
    return NextResponse.json(
      { connections: rows.map((g) => ({ id: g.id, name: g.clientName || "AI assistant", since: g.createdAt, lastRead: g.lastUsedAt })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return serverError(e, { label: "connections-read" });
  }
}

export async function POST(request) {
  const limited = rateLimit(request, "connections-write", 20);
  if (limited) return limited;
  try {
    const { profile, disconnect } = await request.json().catch(() => ({}));
    if (!profile || typeof disconnect !== "string" || !(await gate(request, profile))) return denied();
    const store = await neonOAuthStore();
    if (!store) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
    const ok = await revokeGrantFor(store, profile, disconnect);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    return serverError(e, { label: "connections-write" });
  }
}
