import { rateLimit } from "@/lib/rate-limit";
import { exchangeCode, refreshTokens, MCP_RESOURCE } from "@/lib/oauth";
import { neonOAuthStore } from "@/lib/oauth-store";
import { oauthJson, preflight, readParams } from "@/lib/oauth-http";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Token endpoint: code → tokens, refresh → rotated tokens. Errors use the
// RFC 6749 codes so AI clients know to start over.
export async function POST(request) {
  const limited = rateLimit(request, "oauth-token", 30);
  if (limited) return limited;
  try {
    const p = await readParams(request);
    if (p.grant_type !== "authorization_code" && p.grant_type !== "refresh_token") {
      return oauthJson({ error: "unsupported_grant_type" }, 400);
    }
    const store = await neonOAuthStore();
    if (!store) return oauthJson({ error: "temporarily_unavailable" }, 503);
    let r;
    if (p.grant_type === "authorization_code") {
      r = await exchangeCode(store, {
        code: p.code, clientId: p.client_id, redirectUri: p.redirect_uri,
        codeVerifier: p.code_verifier, resource: (p.resource || MCP_RESOURCE).replace(/\/$/, ""),
      });
    } else {
      r = await refreshTokens(store, { refreshToken: p.refresh_token, clientId: p.client_id });
    }
    if (r.error) return oauthJson({ error: r.error }, 400);
    return oauthJson(r.tokens);
  } catch (e) {
    return serverError(e, { label: "oauth-token" });
  }
}

export function OPTIONS() { return preflight(); }
