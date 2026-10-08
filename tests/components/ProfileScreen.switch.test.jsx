// @vitest-environment jsdom
// Profile shows one person. Signed in, the name heads the page and nothing
// sits above it: no list of names, no name field. Other names on this device
// live behind "Not you?" at the foot of More (shown only when there are
// any), with "Sign in as someone else" under it; the heading leads there.
// Deleting is a quiet two-tap row at the foot of Account, for this profile
// only, opening the same sheet. A signed-out device keeps its gate.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  passkeyStatus: vi.fn(async () => ({ hasPasskey: true, consent: { version: 1 } })),
  registerPasskey: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
}));
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  checkProfileExists: vi.fn(async () => ({ exists: false })),
  blobDelete: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

const { default: ProfileScreen } = await import("@/components/ProfileScreen");
const { passkeyStatus } = await import("@/lib/webauthn");
const { blobDelete, checkProfileExists } = await import("@/lib/storage");

const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const props = (over = {}) => ({ existing: ["sam"], current: "sam", onActivate: vi.fn(async () => ({ ok: true })),
  onCancel: vi.fn(), bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn(), ...over });
const settle = () => screen.findByText("Passkey enabled");
const heading = () => screen.getByRole("button", { name: /^sam, / });

let realLocation;
beforeEach(() => {
  vi.clearAllMocks();
  realLocation = window.location;
  Object.defineProperty(window, "location", { value: { reload: vi.fn() }, writable: true, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "location", { value: realLocation, writable: true, configurable: true });
});

describe("Profile: the top is one person", () => {
  it("the name heads the page; no list of names, no Add new, no name field up top", async () => {
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    const h = heading();
    expect(h.textContent).toBe("sam");
    expect(h.getAttribute("aria-label")).toBe("sam, switch or sign in as someone else");
    // The page heading, for screen readers: one level-1 heading, the name.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).contains(h)).toBe(true);
    // Nothing above it but the way back home.
    const home = screen.getByRole("button", { name: "Home" });
    const page = home.parentElement;
    expect([...page.children].slice(0, 2).map((el) => el.contains(h) || el === home)).toEqual([true, true]);
    expect(before(home, h)).toBe(true);
    for (const gone of ["Profiles", "This device", "Add new", "Active", "Pick a profile, or add someone new."]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
    expect(screen.queryByText("alex")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Wipe / })).toBeNull();
    expect(before(h, screen.getByText("Coaching"))).toBe(true);
  });
});

describe("Profile: Not you?", () => {
  it("is absent with one name; Sign in as someone else stays at the foot of More", async () => {
    render(<ProfileScreen {...props()} />);
    await settle();
    expect(screen.queryByText("Not you?")).toBeNull();
    const signIn = screen.getByRole("button", { name: "Sign in as someone else" });
    expect(before(screen.getByText("Privacy"), signIn)).toBe(true);
    expect(before(screen.getByText("More"), signIn)).toBe(true);
  });

  it("with two names, sits at the foot of More and expands inline to the other name", async () => {
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    const toggle = screen.getByRole("button", { name: /^Not you\?/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(before(screen.getByText("Privacy"), toggle)).toBe(true);
    expect(screen.queryByRole("button", { name: "alex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in as someone else" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    const alex = screen.getByRole("button", { name: "alex" });
    const signIn = screen.getByRole("button", { name: "Sign in as someone else" });
    expect(before(toggle, alex) && before(alex, signIn)).toBe(true);
    // The signed-in name is not offered as someone else.
    expect(screen.queryByRole("button", { name: "sam" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "alex" })).toBeNull();
  });

  it("switching calls onActivate with the other name, and nothing else", async () => {
    const p = props({ existing: ["sam", "alex", "jo"] });
    render(<ProfileScreen {...p} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Not you\?/ }));
    fireEvent.click(screen.getByRole("button", { name: "jo" }));
    expect(p.onActivate).toHaveBeenCalledTimes(1);
    expect(p.onActivate.mock.calls[0]).toEqual(["jo"]);
  });

  it("Sign in as someone else reveals the name field and runs the claim flow", async () => {
    const p = props({ existing: ["sam", "alex"] });
    render(<ProfileScreen {...p} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Not you\?/ }));
    const signIn = screen.getByRole("button", { name: "Sign in as someone else" });
    expect(signIn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(signIn);
    expect(signIn.getAttribute("aria-expanded")).toBe("true");
    const input = screen.getByRole("textbox", { name: "Your name" });
    expect(before(signIn, input)).toBe(true);
    fireEvent.change(input, { target: { value: "  Kim " } });
    expect(await screen.findByText("Available · this will be your username", {}, { timeout: 2000 })).toBeTruthy();
    expect(checkProfileExists).toHaveBeenCalledWith("Kim");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(p.onActivate).toHaveBeenCalledTimes(1));
    expect(p.onActivate.mock.calls[0]).toEqual(["Kim", { claim: true }]);
  });

  it("a name already on this device signs in without a claim", async () => {
    const p = props({ existing: ["sam", "alex"] });
    render(<ProfileScreen {...p} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Not you\?/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as someone else" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), { target: { value: "Alex" } });
    expect(screen.getByText("Welcome back")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your name" }), { key: "Enter" });
    await waitFor(() => expect(p.onActivate).toHaveBeenCalledTimes(1));
    expect(p.onActivate.mock.calls[0]).toEqual(["Alex", { claim: false }]);
    expect(checkProfileExists).not.toHaveBeenCalled();
  });

  it("the name heading is a button that opens the same place, focus on Not you?", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
      await settle();
      fireEvent.click(heading());
      const toggle = screen.getByRole("button", { name: /^Not you\?/ });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "alex" })).toBeTruthy();
      expect(document.activeElement).toBe(toggle);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(document.getElementById("profile-switch"));
      expect(heading().getAttribute("aria-controls")).toBe("profile-switch");
    } finally { delete Element.prototype.scrollIntoView; }
  });

  it("with one name, the heading leads to Sign in as someone else", async () => {
    render(<ProfileScreen {...props()} />);
    await settle();
    fireEvent.click(heading());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sign in as someone else" }));
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("asks the passkey status of the signed-in profile only", async () => {
    render(<ProfileScreen {...props({ existing: ["sam", "alex", "jo"] })} />);
    await settle();
    expect(passkeyStatus.mock.calls).toEqual([["sam"]]);
  });
});

describe("Profile: Delete this profile", () => {
  const seed = () => {
    localStorage.setItem("forge:profiles", JSON.stringify(["sam", "alex"]));
    localStorage.setItem("forge:active", JSON.stringify("sam"));
    for (const who of ["sam", "alex"]) {
      localStorage.setItem(`forge:${who}:weights`, "{}");
      localStorage.setItem(`forge:${who}:history`, "[]");
    }
  };
  const row = () => screen.getByRole("button", { name: /delete this profile$/i });

  it("sits at the foot of Account, before Device, and the crosses are gone", async () => {
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    expect(row().textContent).toBe("Delete this profile");
    expect(before(screen.getByRole("button", { name: "Sync now" }), row())).toBe(true);
    expect(before(row(), screen.getByText("Device"))).toBe(true);
    expect(screen.queryAllByTitle("Wipe progress")).toEqual([]);
  });

  it("the first tap arms, the second opens the sheet for this profile; 5s disarms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    fireEvent.click(row());
    expect(row().textContent).toBe("Tap again to delete this profile");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(row().textContent).toBe("Delete this profile");
    fireEvent.click(row());
    fireEvent.click(row());
    const sheet = screen.getByRole("dialog", { name: "Delete sam?" });
    expect(within(sheet).getByText("Remove from this device")).toBeTruthy();
    expect(within(sheet).getByText("Full wipe · cloud & device")).toBeTruthy();
    expect(row().textContent).toBe("Delete this profile");
  });

  it("Remove from this device clears this profile's keys only and reloads", async () => {
    seed();
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    fireEvent.click(row()); fireEvent.click(row());
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Remove from this device")); });
    expect(blobDelete).not.toHaveBeenCalled();
    expect(localStorage.getItem("forge:sam:weights")).toBeNull();
    expect(localStorage.getItem("forge:sam:history")).toBeNull();
    expect(localStorage.getItem("forge:alex:weights")).toBe("{}");
    expect(localStorage.getItem("forge:alex:history")).toBe("[]");
    expect(JSON.parse(localStorage.getItem("forge:profiles"))).toEqual(["alex"]);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("Full wipe makes the same cloud call, for this profile", async () => {
    seed();
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await settle();
    fireEvent.click(row()); fireEvent.click(row());
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Full wipe · cloud & device")); });
    expect(blobDelete.mock.calls).toEqual([["sam", { authToken: null }]]);
    expect(localStorage.getItem("forge:alex:weights")).toBe("{}");
    expect(JSON.parse(localStorage.getItem("forge:profiles"))).toEqual(["alex"]);
  });

  it("a confirmed passkey-less profile gets the one-choice sheet, as before", async () => {
    passkeyStatus.mockResolvedValueOnce({ hasPasskey: false, consent: null });
    render(<ProfileScreen {...props({ existing: ["sam", "alex"] })} />);
    await waitFor(() => expect(passkeyStatus).toHaveBeenCalledWith("sam"));
    await act(async () => {});
    fireEvent.click(row()); fireEvent.click(row());
    const sheet = screen.getByRole("dialog", { name: "Delete sam?" });
    expect(within(sheet).getByText(/nothing ever synced/)).toBeTruthy();
    expect(within(sheet).queryByText("Full wipe · cloud & device")).toBeNull();
  });
});

describe("Profile: a signed-out device keeps its gate", () => {
  it("names to tap, Add new and the field; no crosses, no Not you?, no Delete row", async () => {
    const p = props({ existing: ["sam", "alex"], current: null, onCancel: null });
    render(<ProfileScreen {...p} />);
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("Profiles")).toBeTruthy();
    expect(screen.getByText("Pick a profile, or add someone new.")).toBeTruthy();
    expect(screen.getByText("Add new")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeTruthy();
    expect(before(screen.getByText("alex"), screen.getByText("Add new"))).toBe(true);
    fireEvent.click(screen.getByText("alex"));
    expect(p.onActivate.mock.calls).toEqual([["alex"]]);
    expect(screen.queryByRole("button", { name: /^Wipe / })).toBeNull();
    expect(screen.queryByText("Not you?")).toBeNull();
    expect(screen.queryByText("Sign in as someone else")).toBeNull();
    expect(screen.queryByText("Delete this profile")).toBeNull();
    expect(passkeyStatus).not.toHaveBeenCalled();
  });

  it("a fresh device is unchanged: New here, Your name, Name", async () => {
    render(<ProfileScreen {...props({ existing: [], current: null, onCancel: null })} />);
    expect(screen.getByText("New here")).toBeTruthy();
    expect(screen.getByText("Your name")).toBeTruthy();
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("We don't want your starsign either.")).toBeTruthy();
  });
});
