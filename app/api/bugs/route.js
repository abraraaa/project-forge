import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-errors";
import { rateLimit } from "@/lib/rate-limit";
import { readTokenData, resolveTokenIdentity, isAdminIdentity } from "@/lib/auth-server";
import { hasDb, dbInsertBug, dbListBugs, dbUpdateBugStatus, BUG_STATUSES } from "@/lib/db";
import { dbMarkSeen } from "@/lib/notices";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Bug reports — the boss's fill-or-kill flow (parked 2026-07-24, built for
// the flip window: live intake BEFORE the domain moves means flip breakage
// arrives through the app, not the void).
//
//   POST  { message, profile?, context? }  — open (submitting needs no auth;
//         spam is bounded by the hard rate limit + length cap, and rows are
//         inert text). ua/route captured server-side into context.
//   GET   → the report list. Ceremony-token gated: reports are THIRD-PARTY
//         text, not the submitter's own profile data, so the open-reads
//         doctrine (#20/#21) does NOT extend here. A successful list by the
//         admin account then marks the bug notice seen (dbMarkSeen, an
//         overwrite in place of that account's one 'bugs' mark).
//   PATCH { id, status } — status-only triage transition. Same gate.
//         ADMIN RECOGNITION (boss, 2026-07-26): when ADMIN_ACCOUNT_ID (or
//         the ADMIN_PROFILE fallback) is set, the ceremony token must belong
//         to THAT account — the app now knows who the boss is. Unset (dev):
//         any passkey holder, the documented pre-admin behaviour. Either way there is NO delete
//         verb for this table anywhere.

const MAX_MESSAGE_LEN = 2000;

/** @returns {Promise<{ denied: Response } | { identity: import("@/lib/identity").Identity }>} */
async function ceremonyGate(request) {
  const token = request.headers.get("x-hw-auth") || null;
  const data = await readTokenData(token);
  // Live, unscoped ceremony token; no scoped token qualifies (same posture
  // as the wipe gate: a new scope is refused by default).
  if (!data || data.scope || typeof data.expires !== "number" || Date.now() > data.expires) {
    return { denied: NextResponse.json({ error: "Passkey authentication required", requiresAuth: true }, { status: 401 }) };
  }
  // The account the token was minted for. No handle is named here.
  const identity = await resolveTokenIdentity(data, null, Date.now());
  if (!identity) {
    return { denied: NextResponse.json({ error: "Passkey authentication required", requiresAuth: true }, { status: 401 }) };
  }
  // Admin recognition: the token must be the boss's. Server-side ONLY —
  // the client admin flag is a UI hint.
  //
  // FAILS CLOSED when both ADMIN_ACCOUNT_ID and ADMIN_PROFILE are unset
  // (deep audit 2026-07-26). The check used to be
  // `if (process.env.ADMIN_PROFILE && ...)`, so an absent,
  // empty or mistyped env var silently opened this wing to ANY passkey
  // holder — every bug report, with submitter names and free text, plus
  // triage mutation. That is the same failure shape as the 2026-07-09
  // incident: behaviour changing as a side effect of an env-var state. The
  // cron routes already get this right by 500ing on a missing secret.
  //
  // Dev convenience is preserved deliberately and narrowly: outside
  // production an unset var still opens the wing, so a local checkout with
  // no env file remains usable.
  if (!process.env.ADMIN_ACCOUNT_ID && !process.env.ADMIN_PROFILE) {
    if (process.env.NODE_ENV === "production") {
      return { denied: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
    }
  } else if (!isAdminIdentity(identity)) {
    return { denied: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { identity };
}

export async function POST(request) {
  const limited = rateLimit(request, "bugs-submit", 5);
  if (limited) return limited;
  try {
    if (!hasDb()) return NextResponse.json({ error: "Reports unavailable" }, { status: 503 });
    // Body cap before parse (audit 2026-07-26, P3): this is unauthenticated
    // open intake, and only `message` (≤2000) is length-checked AFTER parse.
    // Read as text and measure so a chunked body can't skip the guard.
    const text = await request.text();
    if (text.length > 16 * 1024) return NextResponse.json({ error: "Body too large" }, { status: 413 });
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
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
    return serverError(e, { label: "bugs" });
  }
}

export async function GET(request) {
  const limited = rateLimit(request, "bugs-review", 30);
  if (limited) return limited;
  const g = await ceremonyGate(request);
  if ("denied" in g) return g.denied;
  try {
    // The mark's time is taken before the read, so a report that lands mid-read stays new.
    const at = Date.now();
    const rows = await dbListBugs();
    // Only the admin account has a bug notice (lib/notices.js); a failed mark never fails the list.
    if (isAdminIdentity(g.identity)) {
      try {
        await dbMarkSeen(g.identity.accountId, "bugs", at);
      } catch (e) {
        serverError(e, { label: "bugs-seen" });
      }
    }
    return NextResponse.json({ reports: rows });
  } catch (e) {
    return serverError(e, { label: "bugs" });
  }
}

export async function PATCH(request) {
  const limited = rateLimit(request, "bugs-review", 30);
  if (limited) return limited;
  const g = await ceremonyGate(request);
  if ("denied" in g) return g.denied;
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
    return serverError(e, { label: "bugs" });
  }
}
