import { NextResponse } from "next/server";
import { rateLimit, rateLimitShared } from "@/lib/rate-limit";
import { readTokenData, resolveTokenIdentity } from "@/lib/auth-server";
import { issueCode } from "@/lib/oauth";
import { neonOAuthStore } from "@/lib/oauth-store";
import { resolveClient } from "@/lib/oauth-cimd";
import { checkAuthorizeParams, consentFromToken, redirectWith } from "@/lib/oauth-http";
import { credentialExists } from "@/lib/oauth-credentials";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// POST /api/oauth/consent — the /connect page calls this after Face ID.
//   { authToken, profile, params: <the /connect query>, approve: boolean }
// → { redirect } — the browser goes back to the AI with a code, or with
// access_denied. The account and the passkey come from the server's token
// record, never from the request body; `profile` (the handle) must resolve
// to that same account.
export async function POST(request) {
  const limited = rateLimit(request, "oauth-consent", 10) || await rateLimitShared(request, "oauth-consent", 10);
  if (limited) return limited;
  try {
    const { authToken, profile, params, approve } = await request.json().catch(() => ({}));
    const q = params && typeof params === "object" ? params : {};
    const store = await neonOAuthStore();
    if (!store) return NextResponse.json({ error: "Connections are unavailable right now." }, { status: 503 });

    const client = q.client_id ? await resolveClient(store, String(q.client_id)) : null;
    const checked = checkAuthorizeParams(q, client);
    if (checked.fatal) return NextResponse.json({ error: checked.fatal }, { status: 400 });
    if (checked.redirectError) {
      return NextResponse.json({ redirect: redirectWith(q.redirect_uri, { error: checked.redirectError, state: q.state }) });
    }
    const a = checked.ok;
    if (!approve) {
      return NextResponse.json({ redirect: redirectWith(a.redirectUri, { error: "access_denied", state: a.state }) });
    }

    const now = Date.now();
    const tokenData = await readTokenData(authToken);
    const id = typeof profile === "string" && profile ? await resolveTokenIdentity(tokenData, profile, now) : null;
    const consent = consentFromToken(tokenData, now);
    if (!id || !consent || !(await credentialExists(id, consent.credentialId))) {
      return NextResponse.json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, { status: 401 });
    }

    const r = await issueCode(store, {
      clientId: client.id, accountId: id.accountId, profile: id.storageKey, credentialId: consent.credentialId,
      redirectUri: a.redirectUri, codeChallenge: a.codeChallenge, codeChallengeMethod: "S256",
      scope: a.scope, resource: a.resource,
    });
    if (r.error) {
      return NextResponse.json({ redirect: redirectWith(a.redirectUri, { error: r.error, state: a.state }) });
    }
    return NextResponse.json({ redirect: redirectWith(a.redirectUri, { code: r.code, state: a.state }) });
  } catch (e) {
    return serverError(e, { label: "oauth-consent" });
  }
}
