import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, isTokenValid } from "@/lib/auth-server";
import { hasDb, dbInsertBug, dbListBugs, dbUpdateBugStatus, BUG_STATUSES } from "@/lib/db";

// Bug reports — the boss's fill-or-kill flow (parked 2026-07-24, built for
// the flip window: live intake BEFORE the domain moves means flip breakage
// arrives through the app, not the void).
//
//   POST  { message, profile?, context? }  — open (submitting needs no auth;
//         spam is bounded by the hard rate limit + length cap, and rows are
//         inert text). ua/route captured server-side into context.
//   GET   → the report list. Ceremony-token gated: reports are THIRD-PARTY
//         text, not the submitter's own profile data, so the open-reads
//         doctrine (#20/#21) does NOT extend here.
//   PATCH { id, status } — status-only triage transition. Same gate. Honest
//         scope note: "admin" isn't a concept in Forge, so ANY valid
//         passkey ceremony token authorises triage. Stakes are triage
//         metadata only — there is NO delete verb for this table anywhere,
//         so the worst abuse is a mislabeled status, which is re-labelable.

const MAX_MESSAGE_LEN = 2000;

async function ceremonyGate(request) {
  const token = request.headers.get("x-hw-auth") || null;
  const data = await readTokenData(token);
  // Any profile's live ceremony token; photo-scope cookies don't qualify
  // (same posture as the wipe gate — triage is not a photo surface).
  if (!data || data.scope === "photos" || typeof data.expires !== "number" || Date.now() > data.expires) {
    return NextResponse.json({ error: "Passkey authentication required", requiresAuth: true }, { status: 401 });
  }
  return null;
}

export async function POST(request) {
  const limited = rateLimit(request, "bugs-submit", 5);
  if (limited) return limited;
  try {
    if (!hasDb()) return NextResponse.json({ error: "Reports unavailable" }, { status: 503 });
    const body = await request.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message || message.length > MAX_MESSAGE_LEN) {
      return NextResponse.json({ error: "Message required (max 2000 chars)" }, { status: 400 });
    }
    const profile = typeof body?.profile === "string" && body.profile.length <= 64 ? body.profile : null;
    const context = {
      route: typeof body?.context?.route === "string" ? body.context.route.slice(0, 200) : null,
      ua: (request.headers.get("user-agent") || "").slice(0, 300),
    };
    await dbInsertBug({ profile, message, context });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(request) {
  const limited = rateLimit(request, "bugs-review", 30);
  if (limited) return limited;
  const denied = await ceremonyGate(request);
  if (denied) return denied;
  try {
    const rows = await dbListBugs();
    return NextResponse.json({ reports: rows });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  const limited = rateLimit(request, "bugs-review", 30);
  if (limited) return limited;
  const denied = await ceremonyGate(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    const status = body?.status;
    if (!Number.isInteger(id) || !BUG_STATUSES.has(status)) {
      return NextResponse.json({ error: "id + valid status required" }, { status: 400 });
    }
    await dbUpdateBugStatus(id, status);
    return NextResponse.json({ ok: true, id, status });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
