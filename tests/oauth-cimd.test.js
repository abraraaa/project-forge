import { describe, it, expect } from "vitest";
import { isCimdClientId, clientFromDocument, resolveClient, CIMD_TTL_MS } from "../lib/oauth-cimd.js";
import { memoryStore, issueCode, exchangeCode } from "../lib/oauth.js";
import { authorizationServerMetadata } from "../lib/oauth-http.js";
import { createHash } from "node:crypto";

const URL_ID = "https://claude.ai/oauth/mcp-client.json";
const DOC = { client_id: URL_ID, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" };
const fakeFetch = (body, { status = 200, calls = [] } = {}) => async (url, init) => {
  calls.push({ url, init });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};

describe("which client_ids we will fetch", () => {
  it("https URLs with a path on a public name", () => {
    expect(isCimdClientId(URL_ID)).toBe(true);
    expect(isCimdClientId("hwc_abc")).toBe(false);
  });
  it("never local, internal, IP literals, ports, credentials or bare origins", () => {
    for (const bad of [
      "http://claude.ai/client.json", "https://localhost/c.json", "https://127.0.0.1/c.json",
      "https://[::1]/c.json", "https://10.0.0.1/c.json", "https://box.internal/c.json", "https://printer.local/c.json",
      "https://claude.ai:8443/c.json", "https://u:p@claude.ai/c.json", "https://claude.ai/", "https://intranet/c.json",
    ]) expect(isCimdClientId(bad), bad).toBe(false);
  });
});

describe("the document must vouch for itself", () => {
  it("accepts a matching public client", () => {
    expect(clientFromDocument(URL_ID, DOC)).toEqual({ id: URL_ID, name: "Claude", redirectUris: DOC.redirect_uris });
  });
  it("rejects a mismatched id, bad redirects, or a confidential client", () => {
    expect(clientFromDocument(URL_ID, { ...DOC, client_id: "https://evil.example/c.json" })).toBeNull();
    expect(clientFromDocument(URL_ID, { ...DOC, redirect_uris: ["http://evil.example/cb"] })).toBeNull();
    expect(clientFromDocument(URL_ID, { ...DOC, redirect_uris: [] })).toBeNull();
    expect(clientFromDocument(URL_ID, { ...DOC, token_endpoint_auth_method: "client_secret_basic" })).toBeNull();
  });
});

describe("resolveClient", () => {
  it("fetches once, without following redirects, then serves the stored copy for a day", async () => {
    const store = memoryStore(), calls = [];
    const now = Date.parse("2026-09-25T10:00:00Z");
    const c1 = await resolveClient(store, URL_ID, { fetchImpl: fakeFetch(DOC, { calls }), now });
    expect(c1.name).toBe("Claude");
    expect(calls[0].init.redirect).toBe("error");
    await resolveClient(store, URL_ID, { fetchImpl: fakeFetch(DOC, { calls }), now: now + 3600e3 });
    expect(calls).toHaveLength(1);
    await resolveClient(store, URL_ID, { fetchImpl: fakeFetch({ ...DOC, client_name: "Claude 2" }, { calls }), now: now + CIMD_TTL_MS + 1 });
    expect(calls).toHaveLength(2);
    expect((await store.getClient(URL_ID)).name).toBe("Claude 2");
  });
  it("a failed re-check keeps the last good copy; a first failure is no client", async () => {
    const store = memoryStore(), now = Date.parse("2026-09-25T10:00:00Z");
    expect(await resolveClient(store, URL_ID, { fetchImpl: fakeFetch("nope", { status: 500 }), now })).toBeNull();
    await resolveClient(store, URL_ID, { fetchImpl: fakeFetch(DOC), now });
    const kept = await resolveClient(store, URL_ID, { fetchImpl: async () => { throw new Error("down"); }, now: now + CIMD_TTL_MS + 1 });
    expect(kept.name).toBe("Claude");
  });
  it("refuses oversize documents", async () => {
    const big = { ...DOC, client_name: "x".repeat(20000) };
    expect(await resolveClient(memoryStore(), URL_ID, { fetchImpl: fakeFetch(big), now: 1 })).toBeNull();
  });
  it("registered ids never trigger a fetch", async () => {
    let fetched = false;
    await resolveClient(memoryStore(), "hwc_abc", { fetchImpl: async () => { fetched = true; return new Response("{}"); } });
    expect(fetched).toBe(false);
  });
  it("a URL client runs the whole code flow once resolved", async () => {
    const store = memoryStore();
    await resolveClient(store, URL_ID, { fetchImpl: fakeFetch(DOC), now: Date.now() });
    const verifier = "v".repeat(50);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await issueCode(store, { clientId: URL_ID, profile: "sam", credentialId: "cred", redirectUri: DOC.redirect_uris[0], codeChallenge: challenge, codeChallengeMethod: "S256" });
    const r = await exchangeCode(store, { code, clientId: URL_ID, redirectUri: DOC.redirect_uris[0], codeVerifier: verifier });
    expect(r.tokens?.access_token).toBeTruthy();
  });
  it("discovery says we support it", () => {
    expect(authorizationServerMetadata().client_id_metadata_document_supported).toBe(true);
  });
});
