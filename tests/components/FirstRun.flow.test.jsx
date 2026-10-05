// @vitest-environment jsdom
// First run, end to end through ForgeApp: a claim that is the device's first
// profile opens FirstRun (Passkey → Focus → Main lifts → Days → Bodyweight)
// before home, Keep writes nothing, a change writes once through the existing
// cores, Let's go records a bodyweight when none is stored, and a second
// profile on the device goes straight home. The three
// step components are stubbed to their contract (components/first-run/*).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

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
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  claimProfile: vi.fn(async () => ({ ok: true })),
  backgroundSync: vi.fn(async () => {}),
  enableAutoSync: vi.fn(),
  disableAutoSync: vi.fn(),
  pushNow: vi.fn(async () => ({ ok: true })),
  flushPendingPushes: vi.fn(async () => {}),
  ensurePersistentStorage: vi.fn(async () => {}),
}));
// The gate: one button per way in. ProfileScreen's own name flow has its tests.
vi.mock("@/components/ProfileScreen", () => ({
  default: ({ existing, onActivate }) => (
    <div>
      <span data-testid="gate">{existing.join(",")}</span>
      <button onClick={() => onActivate("Sam", { claim: true })}>Claim Sam</button>
      <button onClick={() => onActivate("Ali", { claim: true })}>Claim Ali</button>
      <button onClick={() => onActivate("Sam")}>Sign in Sam</button>
    </div>
  ),
}));
vi.mock("@/components/HomeScreen", () => ({ default: ({ profileName }) => <div>Home of {profileName}</div> }));
// Step stubs, built to the shared contract.
vi.mock("@/components/first-run/FocusStep", () => ({
  default: ({ value, onChange, onNext }) => (
    <div>
      <h1>Focus</h1>
      <button onClick={() => onChange("Strong")}>Pick Strong</button>
      <button onClick={onNext}>Keep {value}</button>
    </div>
  ),
}));
vi.mock("@/components/first-run/MainLiftsStep", () => ({
  default: ({ mainLifts, onChange, onNext }) => (
    <div>
      <h1>Main lifts</h1>
      <span data-testid="squat">{mainLifts["Barbell Back Squat"]}</span>
      <span data-testid="slots">{Object.keys(mainLifts).length}</span>
      <button onClick={() => onChange("Barbell Back Squat", "Front Squat")}>Swap squat</button>
      <button onClick={onNext}>Keep these</button>
    </div>
  ),
}));
vi.mock("@/components/first-run/DaysStep", async () => {
  const { moveStrengthDays } = await vi.importActual("@/lib/first-run");
  return {
    default: ({ week, onChange, onNext }) => (
      <div>
        <h1>Strength days</h1>
        <button onClick={() => onChange(moveStrengthDays(week, [1, 3, 5]))}>Tue Thu Sat</button>
        <button onClick={() => onChange(moveStrengthDays(week, [0, 2, 4]))}>Mon Wed Fri</button>
        <button onClick={onNext}>Keep days</button>
      </div>
    ),
  };
});

const { default: ForgeApp } = await import("@/components/ForgeApp");
const { default: FirstRun } = await import("@/components/FirstRun");
const { registerPasskey, isPlatformAuthenticatorAvailable, hasPasskey } = await import("@/lib/webauthn");
const { F, P, W, BW } = await import("@/lib/storage");
const { CONSENT_VERSION, CONSENT_COPY } = await import("@/lib/consent");

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAuthenticatorAvailable.mockResolvedValue(true);
  registerPasskey.mockResolvedValue({ ok: true });
  localStorage.setItem("forge:onboarded", "true");
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
});

// Every key a first run could write for a profile, beyond what activation sets.
const PROFILE_WRITES = ["focus", "focusStamp", "mainLifts", "mainLiftStamps", "weekConfig", "bodyweight"];
const written = (n) => PROFILE_WRITES.filter((k) => localStorage.getItem(`forge:${n}:${k}`) !== null);

async function claim(name = "Sam") {
  render(<ForgeApp />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Claim ${name}` })); });
}
const press = (name) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("first run on a fresh device", () => {
  it("a fresh claim opens the passkey step; all-Keep then Let's go writes only the bodyweight shown", async () => {
    await claim();
    expect(await screen.findByRole("button", { name: /Add passkey/ })).toBeTruthy();
    expect(screen.queryByTestId("gate")).toBeNull();
    expect(screen.queryByText(/Home of/)).toBeNull();
    // Only a fresh claim asks, at activation; home's hydrate asks again.
    expect(isPlatformAuthenticatorAvailable).toHaveBeenCalledTimes(2);

    await press("Later");
    await screen.findByRole("heading", { name: "Focus" });
    await press("Keep Forged");
    await screen.findByRole("heading", { name: "Main lifts" });
    expect(screen.getByTestId("slots").textContent).toBe("5");
    expect(screen.getByTestId("squat").textContent).toBe("Barbell Back Squat");
    await press("Keep these");
    await screen.findByRole("heading", { name: "Strength days" });
    await press("Keep days");
    expect(screen.getByText("Bodyweight")).toBeTruthy();
    const passkeyChecks = hasPasskey.mock.calls.length;
    await press("Let's go");

    expect(await screen.findByText("Home of Sam")).toBeTruthy();
    // Nothing stored, so the drum's 75 is the answer: the one write, and
    // home has no stale-bodyweight card asking again.
    expect(written("Sam")).toEqual(["bodyweight"]);
    expect(BW.getKg("Sam")).toBe(75);
    expect(BW.isStale("Sam")).toBe(false);
    expect(W.get("Sam")).toBeNull();
    expect(registerPasskey).not.toHaveBeenCalled();
    // Finishing re-reads the passkey so the home nudge sees one added here.
    expect(hasPasskey.mock.calls.length).toBe(passkeyChecks + 1);
    expect(hasPasskey).toHaveBeenLastCalledWith("Sam");
  });

  it("Skip on the bodyweight step reaches home writing nothing", async () => {
    await claim();
    await press("Later");
    await press("Keep Forged");
    await press("Keep these");
    await press("Keep days");
    await press("Skip");
    expect(await screen.findByText("Home of Sam")).toBeTruthy();
    expect(written("Sam")).toEqual([]);
  });

  it("a change on each step writes once, through the stores Profile reads", async () => {
    await claim();
    await press("Later");
    await press("Pick Strong");
    expect(screen.getByRole("button", { name: "Keep Strong" })).toBeTruthy();
    await press("Keep Strong");
    await press("Swap squat");
    expect(screen.getByTestId("squat").textContent).toBe("Front Squat");
    await press("Keep these");
    await press("Tue Thu Sat");
    await press("Keep days");
    const drum = screen.getAllByText("76")[0];
    await act(async () => { fireEvent.click(drum); });
    await press("Let's go");

    await screen.findByText("Home of Sam");
    // The focus core's rotation summary is dropped, not carried home.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(F.get("Sam")).toBe("Strong");
    expect(P.getMainLifts("Sam")).toEqual({ "Barbell Back Squat": "Front Squat" });
    expect(W.get("Sam").map((d) => d.type)).toEqual(["zone2", "strength", "cardio", "strength", "hiit", "strength", "rest"]);
    expect(BW.getKg("Sam")).toBe(76);
  });

  it("Add passkey registers with the consent claim, then moves on", async () => {
    await claim();
    const add = screen.getByRole("button", { name: /Add passkey/ });
    const line = screen.getByText(CONSENT_COPY.line);
    expect(follows(add, line)).toBe(true);
    expect(add.getAttribute("aria-describedby")).toBe("consent-onboarding");
    expect(document.getElementById("consent-onboarding")).toBe(line);
    await act(async () => { fireEvent.click(add); });
    expect(registerPasskey).toHaveBeenCalledWith("Sam", null, { consent: { version: CONSENT_VERSION } });
    expect(await screen.findByRole("heading", { name: "Focus" })).toBeTruthy();
  });

  it("without a platform authenticator, the flow starts at Focus", async () => {
    isPlatformAuthenticatorAvailable.mockResolvedValue(false);
    await claim();
    expect(await screen.findByRole("heading", { name: "Focus" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add passkey/ })).toBeNull();
  });

  it("a capability check that never answers does not hold activation", async () => {
    isPlatformAuthenticatorAvailable.mockReturnValueOnce(new Promise(() => {}));
    await claim();
    expect(await screen.findByRole("heading", { name: "Focus" }, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add passkey/ })).toBeNull();
  });
});

describe("no first run for anyone else", () => {
  it("a second profile claimed on a device with profiles goes straight home", async () => {
    P.add("Sam");
    await claim("Ali");
    expect(await screen.findByText("Home of Ali")).toBeTruthy();
    // ForgeApp's own gate held: only home's hydrate asked, not a first run
    // (FirstRun's existing guard would otherwise mask a broken gate).
    expect(isPlatformAuthenticatorAvailable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Add passkey/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Focus" })).toBeNull();
  });

  it("a sign-in without a claim goes straight home", async () => {
    render(<ForgeApp />);
    await press("Sign in Sam");
    expect(await screen.findByText("Home of Sam")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add passkey/ })).toBeNull();
  });
});

describe("the week is saved only when the days differ", () => {
  it("moving the days and back again writes no week", async () => {
    await claim();
    await press("Later");
    await press("Keep Forged");
    await press("Keep these");
    await press("Tue Thu Sat");
    await press("Mon Wed Fri");
    await press("Keep days");
    await press("Let's go");
    await screen.findByText("Home of Sam");
    expect(written("Sam")).toEqual(["bodyweight"]);
  });
});

describe("FirstRun on its own: save props and the closing line", () => {
  const props = () => ({
    name: "Sam", existing: [], webAuthnSupported: false, bodyweight: null, userFocus: "Forged", mainLifts: {},
    onSaveFocus: vi.fn(), onSaveMainLift: vi.fn(), onSaveWeek: vi.fn(), onSaveBodyweight: vi.fn(), onDone: vi.fn(),
  });
  const saves = (p) => [p.onSaveFocus, p.onSaveMainLift, p.onSaveWeek, p.onSaveBodyweight].map((f) => f.mock.calls.length);
  const toBodyweight = async () => {
    await press("Keep Forged");
    await press("Keep these");
    await press("Keep days");
  };

  it("all Keep with nothing stored: only the shown bodyweight saves, and Let's go names the first strength day", async () => {
    const p = props();
    render(<FirstRun {...p} todayIdx={1} />);
    await toBodyweight();
    expect(screen.getByText("First session: Strength A, Wednesday.")).toBeTruthy();
    await press("Let's go");
    expect(saves(p)).toEqual([0, 0, 0, 1]);
    expect(p.onSaveBodyweight).toHaveBeenCalledWith(75);
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("all Keep with a stored bodyweight: Let's go saves nothing", async () => {
    const p = { ...props(), bodyweight: 82 };
    render(<FirstRun {...p} todayIdx={1} />);
    await toBodyweight();
    await press("Let's go");
    expect(saves(p)).toEqual([0, 0, 0, 0]);
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("one change per step: each save prop once, with the picked value", async () => {
    const p = props();
    render(<FirstRun {...p} todayIdx={0} />);
    await press("Pick Strong");
    await press("Pick Strong"); // same pick again is not a change
    await press("Keep Strong");
    await press("Swap squat");
    await press("Keep these");
    await press("Tue Thu Sat");
    await press("Keep days");
    expect(screen.getByText("First session: Strength A, Tuesday.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByText("80")[0]); });
    await press("Let's go");
    expect(saves(p)).toEqual([1, 1, 1, 1]);
    expect(p.onSaveFocus).toHaveBeenCalledWith("Strong");
    expect(p.onSaveMainLift).toHaveBeenCalledWith("Barbell Back Squat", "Front Squat");
    expect(p.onSaveWeek.mock.calls[0][0].map((d) => d.type)).toEqual(["zone2", "strength", "cardio", "strength", "hiit", "strength", "rest"]);
    expect(p.onSaveBodyweight).toHaveBeenCalledWith(80);
  });

  it("today as a strength day reads as today; Skip leaves a moved drum unsaved", async () => {
    const p = props();
    render(<FirstRun {...p} todayIdx={2} />);
    await toBodyweight();
    expect(screen.getByText("First session: Strength A, today.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByText("80")[0]); });
    await press("Skip");
    expect(p.onSaveBodyweight).not.toHaveBeenCalled();
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("passkey: a cancel stays quiet, a failure says so softly, Later continues", async () => {
    const p = { ...props(), webAuthnSupported: true };
    render(<FirstRun {...p} />);
    registerPasskey.mockResolvedValueOnce(null);
    await press(/Add passkey/);
    expect(screen.getByRole("button", { name: /Add passkey/ })).toBeTruthy();
    expect(screen.queryByText(/didn't complete|Couldn't set up/)).toBeNull();
    registerPasskey.mockResolvedValueOnce({ ok: false });
    await press(/Add passkey/);
    expect(screen.getByText("Setup didn't complete. Try again or skip for now.")).toBeTruthy();
    await press("Later");
    expect(await screen.findByRole("heading", { name: "Focus" })).toBeTruthy();
    expect(saves(p)).toEqual([0, 0, 0, 0]);
  });

  it("with profiles already on the device it renders nothing and hands back", async () => {
    const p = { ...props(), existing: ["Ali"] };
    const { container } = render(<FirstRun {...p} />);
    expect(container.textContent).toBe("");
    await waitFor(() => expect(p.onDone).toHaveBeenCalledTimes(1));
  });
});
