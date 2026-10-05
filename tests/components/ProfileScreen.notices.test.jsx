// @vitest-environment jsdom
// Notices on Profile: what GET /api/sync/notices says appears as words in the
// row's subline, never a badge. Bug reports and Trainer applications (admin),
// Your clients (trainer). For trainers keeps its application-state sublines.
// No answer (offline, 401, a failure) means the rows read as they always have.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  hasPasskey: vi.fn(async () => true),
  passkeyStatus: vi.fn(async () => ({ hasPasskey: true, consent: { version: 1 } })),
  registerPasskey: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  isWebAuthnSupported: () => true,
}));
vi.mock("@/lib/storage", async (io) => ({ ...(await io()), checkProfileExists: vi.fn(async () => ({ exists: false })) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

const { default: ProfileScreen } = await import("@/components/ProfileScreen");
const { default: ProfileView } = await import("@/components/ProfileView");
const { P } = await import("@/lib/storage");

const base = { existing: ["sam"], current: "sam", onActivate: vi.fn(), onCancel: vi.fn(),
  bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn() };
const share = (over = {}) => ({ open: true, trainerOpen: true, trainer: false, sharing: null, ended: null, ...over });
const sub = (title) => screen.getByText(title).closest("a").textContent.replace(title, "");

// The admin wing shows on this device's admin hint (lib/auth-session.js).
beforeEach(() => { localStorage.clear(); localStorage.setItem("forge:sam:adminHint", "1"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("Profile rows read the notices as words", () => {
  it.each([
    ["two new bugs", { bugs: 2 }, "2 new since you looked"],
    ["one new bug", { bugs: 1 }, "1 new since you looked"],
    ["none", {}, "The list — fill or kill"],
    ["no answer", null, "The list — fill or kill"],
  ])("Bug reports, %s", async (_, noticeDots, line) => {
    render(<ProfileScreen {...base} noticeDots={noticeDots} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Bug reports")).toBe(line);
  });

  it.each([
    ["one waiting", { applications: 1 }, "1 waiting"],
    ["three waiting", { applications: 3 }, "3 waiting"],
    ["none", {}, "Approve or deny coaches"],
    ["no answer", null, "Approve or deny coaches"],
  ])("Trainer applications, %s", async (_, noticeDots, line) => {
    render(<ProfileScreen {...base} noticeDots={noticeDots} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Trainer applications")).toBe(line);
  });

  it.each([
    ["something new", { clients: true }, "Something new from your clients"],
    ["nothing new", {}, "See clients who share with you"],
    ["no answer", null, "See clients who share with you"],
  ])("Your clients, %s", async (_, noticeDots, line) => {
    render(<ProfileScreen {...base} trainerShare={share({ trainer: true })} noticeDots={noticeDots} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Your clients")).toBe(line);
  });

  it("anything but a positive whole count reads as nothing new", async () => {
    render(<ProfileScreen {...base} noticeDots={{ bugs: 0, applications: "4", clients: 1 }} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Bug reports")).toBe("The list — fill or kill");
    expect(sub("Trainer applications")).toBe("Approve or deny coaches");
  });

  it.each([
    ["denied", { status: "denied", at: 1, decidedAt: 2, nextAt: Date.now() + 5 * 864e5, seen: false }, "Not this time"],
    ["applied", { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false }, "Application sent"],
  ])("For trainers keeps its own subline when %s", async (_, application, line) => {
    render(<ProfileScreen {...base} trainerShare={share({ application })} noticeDots={{ application: "denied" }} />);
    await screen.findByText("Passkey enabled");
    expect(sub("For trainers")).toBe(line);
  });

  it("counts appear only in their rows: no badges, no other numbers", async () => {
    render(<ProfileScreen {...base} trainerShare={share({ trainer: true })} noticeDots={{ bugs: 2, applications: 3, clients: true }} />);
    await screen.findByText("Passkey enabled");
    expect(screen.getAllByText("2 new since you looked")).toHaveLength(1);
    expect(screen.getAllByText("3 waiting")).toHaveLength(1);
    expect(screen.getAllByText("Something new from your clients")).toHaveLength(1);
    // No element carries a bare count (a pill or a badge would).
    const bare = [...document.body.querySelectorAll("*")].filter((el) => /^\s*[23]\s*$/.test(el.textContent));
    expect(bare).toHaveLength(0);
  });
});

describe("ProfileView fetches the notices once per visit", () => {
  const notices = (url) => String(url).startsWith("/api/sync/notices");
  const mount = (answer) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).startsWith("/api/sync/trainer")) return Response.json(share({ trainer: true }));
      if (notices(url)) return answer();
      return new Response("{}", { status: 404 });
    });
    P.setActive("sam");
    render(<ProfileView />);
    return spy;
  };

  it("fills the sublines from a 200, asking for the active profile", async () => {
    const spy = mount(() => Response.json({ dots: { bugs: 2, applications: 1, clients: true }, admin: true }));
    await screen.findByText("2 new since you looked");
    expect(sub("Trainer applications")).toBe("1 waiting");
    await waitFor(() => expect(sub("Your clients")).toBe("Something new from your clients"));
    const calls = spy.mock.calls.filter(([url]) => notices(url));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/sync/notices?profile=sam");
  });

  it.each([
    ["401", () => new Response("{}", { status: 401 })],
    ["500", () => new Response("{}", { status: 500 })],
    ["offline", () => { throw new TypeError("Failed to fetch"); }],
    ["a body that isn't JSON", () => new Response("nope", { status: 200 })],
  ])("renders no notice words on %s", async (_, answer) => {
    const spy = mount(answer);
    await screen.findByText("Your clients");
    await waitFor(() => expect(spy.mock.calls.filter(([url]) => notices(url))).toHaveLength(1));
    await screen.findByText("Passkey enabled");
    expect(sub("Bug reports")).toBe("The list — fill or kill");
    expect(sub("Trainer applications")).toBe("Approve or deny coaches");
    expect(sub("Your clients")).toBe("See clients who share with you");
    expect(document.body.textContent).not.toMatch(/since you looked|waiting|Something new/);
  });
});
