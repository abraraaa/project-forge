import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { peekInvite } from "@/lib/trainer-store";
import { json, noStore } from "@/lib/trainer-session";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";
export const dynamic = "force-dynamic";

// One answer for every kind of miss, so a probe learns nothing about why.
const MISS = { error: "That code didn't work. Check it, or ask your trainer for a fresh one." };

// POST /api/share/peek  { code } -> { trainer: { name }, expiresAt }
// Names the trainer behind a code before the client approves. Confers
// nothing, so it needs no sign-in, and a miss here never counts against the
// client's approve tries. Limited per IP. Writes only the rate counters.
export async function POST(request) {
  const limited = rateLimit(request, "share-peek", 10) || await rateLimitShared(request, "share-peek", 30);
  if (limited) return noStore(limited);
  try {
    const body = await request.json().catch(() => ({}));
    const code = body && typeof body === "object" ? body.code : undefined;
    const hit = await peekInvite(code);
    if (!hit) return json(MISS, 404);
    return json({ trainer: { name: hit.name }, expiresAt: hit.expiresAt });
  } catch (e) {
    return noStore(serverError(e, { label: "share-peek" }));
  }
}
