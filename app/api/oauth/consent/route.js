import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readTokenData } from "@/lib/auth-server";
import { issueCode } from "@/lib/oauth";
import { neonOAuthStore } from "@/lib/oauth-store";
import { checkAuthorizeParams, consentFromToken, redirectWith } from "@/lib/oauth-http";
import { credentialExists } from "@/lib/oauth-credentials";
import { normaliseProfile } from "@/lib/profile-name";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// POST /api/oauth/consent — the /connect page calls this after Face ID.
//   { authToken, profile, params: <the /connect query>, approve: boolean }
// → { redirect } — the browser goes back to the AI with a code, or with
// access_denied. The passkey comes from the server's token record, never
// from the request body.
export async function POST(request) {
  const limited = rateLimit(request, "oauth-consent", 10);
  if (limited) return limited;
  try {
    const { authToken, profile, params, approve } = await request.json().catch(() => ({}));
    const q = params && typeof params === "object" ? params : {};
    const store = await neonOAuthStore();
    if (!store) return NextResponse.json({ error: "Connections are unavailable right now." }, { status: 503 });

    const client = q.client_id ? await store.getClient(String(q.client_id)) : null;
    const checked = checkAuthorizeParams(q, client);
    if (checked.fatal) return NextResponse.json({ error: checked.fatal }, { status: 400 });
    if (checked.redirectError) {
      return NextResponse.json({ redirect: redirectWith(q.redirect_uri, { error: checked.redirectError, state: q.state }) });
    }
    const a = checked.ok;
    if (!approve) {
      return NextResponse.json({ redirect: redirectWith(a.redirectUri, { error: "access_denied", state: a.state }) });
    }

    const name = normaliseProfile(profile);
    const consent = consentFromToken(await readTokenData(authToken), name, Date.now());
    if (!consent || !(await credentialExists(name, consent.credentialId))) {
      return NextResponse.json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, { status: 401 });
    }

    const r = await issueCode(store, {
      clientId: client.id, profile: name, credentialId: consent.credentialId,
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
