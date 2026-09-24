import { rateLimit } from "@/lib/rate-limit";
import { registerClient } from "@/lib/oauth";
import { neonOAuthStore } from "@/lib/oauth-store";
import { oauthJson, preflight } from "@/lib/oauth-http";
import { serverError } from "@/lib/api-errors";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// RFC 7591 dynamic client registration. Public clients only (PKCE, no
// secret). Registering grants nothing: every connection still needs the
// user's Face ID on /connect.
export async function POST(request) {
  const limited = rateLimit(request, "oauth-register", 10);
  if (limited) return limited;
  try {
    const body = await request.json().catch(() => ({}));
    const store = await neonOAuthStore();
    if (!store) return oauthJson({ error: "temporarily_unavailable" }, 503);
    const r = await registerClient(store, body || {});
    if (r.error) return oauthJson({ error: "invalid_redirect_uri", error_description: "Redirect URIs must be https, or http on loopback." }, 400);
    return oauthJson({
      client_id: r.client.id,
      client_name: r.client.name,
      redirect_uris: r.client.redirectUris,
      client_id_issued_at: Math.floor(r.client.createdAt / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, 201);
  } catch (e) {
    return serverError(e, { label: "oauth-register" });
  }
}

export function OPTIONS() { return preflight(); }
