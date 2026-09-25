import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkAuthorizeParams, consentFromToken, redirectWith, CONSENT_FRESH_MS,
  authorizationServerMetadata, protectedResourceMetadata, preflight, ISSUER,
} from "../lib/oauth-http.js";
import { MCP_RESOURCE, SCOPE_READ } from "../lib/oauth.js";

const client = { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] };
const good = {
  client_id: "hwc_x", redirect_uri: client.redirectUris[0], response_type: "code",
  code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s1",
};

describe("authorize parameters", () => {
  it("accepts a well-formed request, defaulting scope and resource", () => {
    expect(checkAuthorizeParams(good, client).ok).toMatchObject({ scope: SCOPE_READ, resource: MCP_RESOURCE, state: "s1" });
  });
  it("never redirects for an unknown app or an unregistered redirect", () => {
    expect(checkAuthorizeParams(good, null).fatal).toBeTruthy();
    expect(checkAuthorizeParams({ ...good, redirect_uri: "https://evil.example/cb" }, client).fatal).toBeTruthy();
  });
  it("redirects back with an error for bad PKCE, scope, resource or response type", () => {
    expect(checkAuthorizeParams({ ...good, code_challenge_method: "plain" }, client).redirectError).toBe("invalid_request");
    expect(checkAuthorizeParams({ ...good, scope: "training:write" }, client).redirectError).toBe("invalid_scope");
    expect(checkAuthorizeParams({ ...good, resource: "https://other.example/mcp" }, client).redirectError).toBe("invalid_target");
    expect(checkAuthorizeParams({ ...good, response_type: "token" }, client).redirectError).toBe("unsupported_response_type");
    expect(checkAuthorizeParams({ ...good, resource: `${MCP_RESOURCE}/` }, client).ok).toBeTruthy();
  });
  it("adds state and iss to the return URL", () => {
    const u = new URL(redirectWith(good.redirect_uri, { code: "abc", state: "s1" }));
    expect(u.searchParams.get("code")).toBe("abc");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
  });
});

describe("consent needs a fresh Face ID naming its passkey", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const tok = { profile: "sam", expires: now + 3600e3, authAt: new Date(now - 60e3).toISOString(), credentialId: "cred1" };
  it("accepts a fresh, full-scope ceremony token", () => {
    expect(consentFromToken(tok, "sam", now)).toEqual({ credentialId: "cred1" });
  });
  it("refuses stale, scoped, foreign, credential-less or expired tokens", () => {
    expect(consentFromToken({ ...tok, authAt: new Date(now - CONSENT_FRESH_MS - 1).toISOString() }, "sam", now)).toBeNull();
    expect(consentFromToken({ ...tok, scope: "sync" }, "sam", now)).toBeNull();
    expect(consentFromToken(tok, "alex", now)).toBeNull();
    expect(consentFromToken({ ...tok, credentialId: undefined }, "sam", now)).toBeNull();
    expect(consentFromToken({ ...tok, expires: now - 1 }, "sam", now)).toBeNull();
    expect(consentFromToken(null, "sam", now)).toBeNull();
  });
});

describe("discovery", () => {
  it("points the resource at this server and advertises S256 only", () => {
    expect(protectedResourceMetadata()).toMatchObject({ resource: MCP_RESOURCE, authorization_servers: [ISSUER] });
    const m = authorizationServerMetadata();
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/connect`);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
  it("preflight is a bodiless 204", async () => {
    const r = preflight();
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
  });
});

describe("consent route trusts the server's passkey, not the request", () => {
  const src = readFileSync(resolve(__dirname, "../app/api/oauth/consent/route.js"), "utf8");
  it("takes credentialId from the token record only", () => {
    expect(src).toContain("consentFromToken(await readTokenData(authToken)");
    expect(src).toContain("credentialId: consent.credentialId");
    expect(src).not.toMatch(/body\.credentialId|params\.credentialId/);
  });
  it("login-verify records the passkey on the ceremony token", () => {
    const lv = readFileSync(resolve(__dirname, "../app/api/auth/login-verify/route.js"), "utf8");
    expect(lv).toContain("credentialId: matchingCred.id");
  });
});

describe("an unregistered client explains the usual cause", () => {
  it("names the typed-in Client ID and what to do instead", () => {
    const r = checkAuthorizeParams({ client_id: "abrar" }, null);
    expect(r.fatal).toMatch(/Client ID was typed/);
    expect(r.fatal).toMatch(/leave the OAuth fields empty/);
  });
});
