// @vitest-environment jsdom
// The client side of consent: the claim rides the verify body only when a
// caller passes it, and passkeyStatus reports the consent version.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/net", () => ({ fetchWithTimeout: vi.fn() }));
const { fetchWithTimeout } = await import("@/lib/net");
const { registerPasskey, authenticatePasskey, passkeyStatus, hasPasskey } = await import("@/lib/webauthn");
const { CONSENT_VERSION, consentClaim } = await import("@/lib/consent");

const buf = () => new Uint8Array([1]).buffer;
const fakeAttestation = { id: "c1", rawId: buf(), type: "public-key", response: { clientDataJSON: buf(), attestationObject: buf() } };
const fakeAssertion = {
  id: "c1", rawId: buf(), type: "public-key",
  response: { clientDataJSON: buf(), authenticatorData: buf(), signature: buf(), userHandle: null },
};
const ok = (body) => ({ ok: true, json: async () => body });
const OPTIONS = ok({
  challenge: "AQ", rp: { id: "localhost", name: "x" }, user: { id: "AQ", name: "s", displayName: "s" },
  pubKeyCredParams: [], allowCredentials: [],
});
const verifyBody = () => JSON.parse(fetchWithTimeout.mock.calls[1][1].body);

beforeEach(() => {
  fetchWithTimeout.mockReset();
  window.PublicKeyCredential = /** @type {any} */ (function () {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: vi.fn(async () => fakeAttestation), get: vi.fn(async () => fakeAssertion) },
  });
});
afterEach(() => { delete window.PublicKeyCredential; });

describe("registerPasskey", () => {
  it("sends the claim when given one", async () => {
    fetchWithTimeout.mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce(ok({ ok: true }));
    await registerPasskey("sam", null, { consent: consentClaim() });
    expect(verifyBody().consent).toEqual({ version: CONSENT_VERSION });
  });

  it("sends no consent key otherwise", async () => {
    fetchWithTimeout.mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce(ok({ ok: true }));
    await registerPasskey("sam");
    expect(verifyBody()).not.toHaveProperty("consent");

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce(ok({ ok: true }));
    await registerPasskey("sam", "tok");
    expect(verifyBody().authToken).toBe("tok");
    expect(verifyBody()).not.toHaveProperty("consent");
  });
});

describe("authenticatePasskey", () => {
  it("sends the claim only when given one", async () => {
    fetchWithTimeout.mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce(ok({ ok: true, verified: true }));
    await authenticatePasskey("sam", { consent: consentClaim() });
    expect(verifyBody().consent).toEqual({ version: CONSENT_VERSION });

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValueOnce(OPTIONS).mockResolvedValueOnce(ok({ ok: true, verified: true }));
    await authenticatePasskey("sam");
    expect(verifyBody()).not.toHaveProperty("consent");
  });
});

describe("passkeyStatus / hasPasskey", () => {
  it("reports the consent version when the server answered", async () => {
    fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: true, credentialCount: 1, consent: { version: CONSENT_VERSION } }));
    expect(await passkeyStatus("sam")).toEqual({ hasPasskey: true, consent: { version: CONSENT_VERSION } });
    fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: false, credentialCount: 0 }));
    expect(await passkeyStatus("sam")).toEqual({ hasPasskey: false, consent: null });
  });

  it("reads only the version: an `at` in the reply is dropped, a malformed one is null", async () => {
    fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: true, consent: { version: CONSENT_VERSION, at: "t" } }));
    expect(await passkeyStatus("sam")).toEqual({ hasPasskey: true, consent: { version: CONSENT_VERSION } });
    for (const consent of [{ version: 5 }, "yes", { at: "t" }, null]) {
      fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: true, consent }));
      expect((await passkeyStatus("sam")).consent).toBeNull();
    }
  });

  it("null when the check itself failed", async () => {
    fetchWithTimeout.mockResolvedValueOnce({ ok: false });
    expect(await passkeyStatus("sam")).toBeNull();
    fetchWithTimeout.mockRejectedValueOnce(new Error("offline"));
    expect(await passkeyStatus("sam")).toBeNull();
  });

  it("hasPasskey keeps its true / false / null contract", async () => {
    fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: true }));
    expect(await hasPasskey("sam")).toBe(true);
    fetchWithTimeout.mockResolvedValueOnce(ok({ hasPasskey: false }));
    expect(await hasPasskey("sam")).toBe(false);
    fetchWithTimeout.mockResolvedValueOnce({ ok: false });
    expect(await hasPasskey("sam")).toBeNull();
    fetchWithTimeout.mockRejectedValueOnce(new Error("offline"));
    expect(await hasPasskey("sam")).toBeNull();
  });
});
