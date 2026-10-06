// @vitest-environment jsdom
// The working-weight sanity bound (sanitiseWorkingWeights): only a corrupt
// value (a number that is not finite, or over WORKING_WEIGHT_MAX_KG) is
// rewritten, to the category's cold-start cap. Real progression past the
// cold-start cap survives, in the function and through ForgeApp's mount and
// sync paths.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createElement as h } from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { sanitiseWorkingWeights, WORKING_WEIGHT_MAX_KG, CATEGORY_COLD_START_MAX_KG } from "@/lib/lift-translations";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/webauthn", () => ({
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  isWebAuthnSupported: () => true,
  registerPasskey: vi.fn(async () => ({ ok: true })),
  hasPasskey: vi.fn(async () => false),
  passkeyStatus: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
}));
// The network edges only; every store is the real one over jsdom storage.
// backgroundSync hands back whatever the test puts in `remote`, so the sync
// path runs the sanitiser too.
const remote = { meta: /** @type {any} */ (null) };
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  claimProfile: vi.fn(async () => ({ ok: true })),
  backgroundSync: vi.fn(async (_who, opts) => { if (remote.meta) opts?.onUpdate?.({ meta: remote.meta, history: [] }); }),
  enableAutoSync: vi.fn(),
  disableAutoSync: vi.fn(),
  pushNow: vi.fn(async () => ({ ok: true })),
  flushPendingPushes: vi.fn(async () => {}),
  ensurePersistentStorage: vi.fn(async () => {}),
}));
vi.mock("@/components/ProfileScreen", () => ({
  default: ({ onActivate }) => h("button", { onClick: () => onActivate("Sam") }, "Sign in Sam"),
}));
vi.mock("@/components/HomeScreen", () => ({ default: ({ profileName }) => h("div", null, `Home of ${profileName}`) }));

const { default: ForgeApp } = await import("@/components/ForgeApp");
const { P, backgroundSync } = await import("@/lib/storage");

const CALF = "Standing Calf Raise";       // accessory_isolation, cap 25
const THRUST = "Barbell Hip Thrust";      // lower_compound, cap 250
const CURL = "Machine Hamstring Curl";    // accessory_isolation, cap 25
const ISO_CAP = CATEGORY_COLD_START_MAX_KG.accessory_isolation;

describe("sanitiseWorkingWeights: a sanity bound, not a ceiling", () => {
  it("is one number, 400 kg", () => {
    expect(WORKING_WEIGHT_MAX_KG).toBe(400);
    expect(ISO_CAP).toBe(25);
  });

  it("keeps a 100 kg Standing Calf Raise and a 130 kg Barbell Hip Thrust unchanged", () => {
    const w = { [CALF]: 100, [THRUST]: 130 };
    expect(sanitiseWorkingWeights(w)).toBe(w);
    expect(w).toEqual({ [CALF]: 100, [THRUST]: 130 });
  });

  it("keeps a 60 kg machine hamstring curl, and anything up to 400 kg", () => {
    for (const kg of [60, 37.5, 38, 399, 400]) {
      const w = { [CURL]: kg };
      expect(sanitiseWorkingWeights(w), `${kg}`).toBe(w);
    }
  });

  it("rewrites 401 kg and a non-finite number to the category cap, keeping the key", () => {
    for (const bad of [401, 1000, NaN, Infinity, -Infinity]) {
      const w = { [CALF]: bad, [THRUST]: 130 };
      const out = sanitiseWorkingWeights(w);
      expect(out, `${bad}`).not.toBe(w);
      expect(out, `${bad}`).toEqual({ [CALF]: ISO_CAP, [THRUST]: 130 });
    }
    expect(sanitiseWorkingWeights({ [THRUST]: 401 })).toEqual({ [THRUST]: CATEGORY_COLD_START_MAX_KG.lower_compound });
  });

  it("leaves lifts with no cap and non-number entries alone", () => {
    const w = { "Pike Push-Up": 999, [CALF]: null, [CURL]: "twenty" };
    expect(sanitiseWorkingWeights(w)).toBe(w);
  });
});

describe("ForgeApp: a heavy real working weight survives mount and sync", () => {
  afterEach(() => { cleanup(); remote.meta = null; });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("forge:onboarded", "true");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
  });

  const signIn = async () => {
    render(h(ForgeApp));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in Sam" })); });
    expect(await screen.findByText("Home of Sam")).toBeTruthy();
    await waitFor(() => expect(backgroundSync).toHaveBeenCalled());
  };

  it("a stored 100 kg calf raise is not rewritten on mount, nor when a pull brings it", async () => {
    localStorage.setItem("forge:Sam:weights", JSON.stringify({ [CALF]: 100, [THRUST]: 130 }));
    remote.meta = { weights: { [CALF]: 100, [THRUST]: 130 } };
    const save = vi.spyOn(P, "saveWeights");
    await signIn();
    expect(save).not.toHaveBeenCalled();
    expect(P.getWeights("Sam")).toEqual({ [CALF]: 100, [THRUST]: 130 });
    save.mockRestore();
  });

  it("control: a corrupt 401 kg is rewritten to the cap on both paths", async () => {
    localStorage.setItem("forge:Sam:weights", JSON.stringify({ [CALF]: 401 }));
    remote.meta = { weights: { [CALF]: 401 } };
    const save = vi.spyOn(P, "saveWeights");
    await signIn();
    expect(save.mock.calls).toEqual([["Sam", { [CALF]: ISO_CAP }], ["Sam", { [CALF]: ISO_CAP }]]);
    save.mockRestore();
  });
});
