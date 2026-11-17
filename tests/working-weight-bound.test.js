// @vitest-environment jsdom
// The working-weight sanity bound (sanitiseWorkingWeights): a corrupt value
// (a number that is not finite, over WORKING_WEIGHT_MAX_KG, or below 0) reads
// as absent and is never written back. Real progression past the cold-start
// cap survives, in the function and through ForgeApp's mount and sync paths.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createElement as h } from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { sanitiseWorkingWeights, startWeightFor, coldStartFromAnchor, getLiftProfile, WORKING_WEIGHT_MAX_KG, CATEGORY_COLD_START_MAX_KG } from "@/lib/lift-translations";

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

  it("drops 401 kg, a negative and a non-finite number, so they read as absent", () => {
    for (const bad of [401, 1000, -1, -0.5, NaN, Infinity, -Infinity]) {
      const w = { [CALF]: bad, [THRUST]: 130 };
      const out = sanitiseWorkingWeights(w);
      expect(out, `${bad}`).not.toBe(w);
      expect(out, `${bad}`).toEqual({ [THRUST]: 130 });
    }
    expect(sanitiseWorkingWeights({ [THRUST]: 401 })).toEqual({});
    expect(sanitiseWorkingWeights({ "Pike Push-Up": 999 })).toEqual({});
  });

  it("keeps 0 on every kind of lift, 400 and a real 300 kg", () => {
    const w = { "Assisted Pull-Up": 0, "Weighted Pull-Up": 0, [CALF]: 0, [THRUST]: 400, "Hex Bar Deadlift": 300 };
    expect(sanitiseWorkingWeights(w)).toBe(w);
  });

  it("leaves non-number entries alone", () => {
    const w = { [CALF]: null, [CURL]: "twenty" };
    expect(sanitiseWorkingWeights(w)).toBe(w);
  });

  it("a corrupt weight gives the ordinary cold start: the template, else the anchor start", () => {
    const ex = { name: THRUST, weight: 60 };
    for (const bad of [401, -5, NaN]) {
      expect(startWeightFor(ex, { working: { [THRUST]: bad } }), `${bad}`).toBe(60);
      expect(startWeightFor(ex, { working: sanitiseWorkingWeights({ [THRUST]: bad }) }), `${bad}`).toBe(60);
    }
    const muscle = getLiftProfile(THRUST).primaryMuscle;
    const anchors = { [muscle]: { bestE1RM: 140 } };
    const fromAnchor = startWeightFor(ex, { working: {}, anchors });
    expect(coldStartFromAnchor(THRUST, anchors[muscle])).toBeGreaterThan(0);
    expect(fromAnchor).not.toBe(60);
    expect(startWeightFor(ex, { working: { [THRUST]: 401 }, anchors })).toBe(fromAnchor);
    expect(startWeightFor(ex, { working: { [THRUST]: 300 }, anchors })).toBe(300);
  });

  it("the store reads a corrupt weight as absent and a save of another lift keeps it stored", () => {
    localStorage.clear();
    localStorage.setItem("forge:Ann:weights", JSON.stringify({ [CALF]: 401, [THRUST]: 130 }));
    expect(P.getWeights("Ann")).toEqual({ [THRUST]: 130 });
    P.saveWeights("Ann", { ...P.getWeights("Ann"), [THRUST]: 132.5 });
    expect(P.getWeightsRaw("Ann")).toEqual({ [CALF]: 401, [THRUST]: 132.5 });
    // Logging the lift replaces it in the ordinary way.
    P.saveWeights("Ann", { ...P.getWeights("Ann"), [CALF]: 20 });
    expect(P.getWeightsRaw("Ann")).toEqual({ [CALF]: 20, [THRUST]: 132.5 });
    localStorage.clear();
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

  it("a stored corrupt weight writes nothing on mount or sync, and reads as absent", async () => {
    localStorage.setItem("forge:Sam:weights", JSON.stringify({ [CALF]: 401, [THRUST]: 130 }));
    remote.meta = { weights: { [CALF]: 401, [THRUST]: 130 } };
    const save = vi.spyOn(P, "saveWeights");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await signIn();
    expect(save).not.toHaveBeenCalled();
    expect(setItem.mock.calls.filter(([k]) => k === "forge:Sam:weights")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("forge:Sam:weights") || "{}")).toEqual({ [CALF]: 401, [THRUST]: 130 });
    expect(P.getWeights("Sam")).toEqual({ [THRUST]: 130 });
    setItem.mockRestore();
    save.mockRestore();
  });
});
