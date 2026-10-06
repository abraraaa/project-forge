// @vitest-environment jsdom
// Profile row order: Coaching is the first logged-in section (your AI, your
// trainer); Your trainer sits under it. A trainer's Your clients row is in a
// Trainer section of its own, straight after Coaching and above Training; the breather row stays in the Training
// group, above Account/passkey. Someone who isn't a trainer yet finds
// "For trainers" as the last row of More, after Privacy; its subline says
// where an application stands, and opening it after a decision marks the
// decision seen.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

const { default: ProfileScreen } = await import("@/components/ProfileScreen");

afterEach(() => { cleanup(); vi.useRealTimers(); });

// The clock, local noon on a calendar day; only Date is faked, so the
// screen's own timers (fades, findBy) run as usual.
const at = (iso) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const [y, m, d] = iso.split("-").map(Number);
  vi.setSystemTime(new Date(y, m - 1, d, 12));
};

const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const expectOrder = (els) => {
  for (let i = 1; i < els.length; i++) {
    expect(before(els[i - 1], els[i]), `${els[i - 1].textContent} before ${els[i].textContent}`).toBe(true);
  }
};
const base = { existing: ["sam"], current: "sam", onActivate: vi.fn(), onCancel: vi.fn(),
  bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn() };

// GET /api/sync/trainer, as ProfileView passes it on.
const share = (over = {}) => ({ open: true, trainerOpen: false, trainer: false, sharing: null, ended: null, ...over });

describe("Profile: Coaching placement", () => {
  it("renders Coaching, then the trainer row, above Training, breather under Training, then Passkey", async () => {
    render(<ProfileScreen {...base} onOpenBreather={vi.fn()} trainerShare={share()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("Coaching"),
      screen.getByText("Talk it through"),
      screen.getByText("Add a trainer"),
      screen.getByText("Training"),
      screen.getByText("Training focus"),
      screen.getByText("Main lifts"),
      screen.getByText("Bodyweight"),
      screen.getByText("Need a breather?"),
      screen.getByText("Account"),
      passkey,
    ]);
    // The coach link is the section's row and still points at /profile/coach.
    expect(screen.getByText("Talk it through").closest("a").getAttribute("href")).toBe("/profile/coach");
  });

  it("keeps the resting 'On a breather' row in the Training group", async () => {
    render(<ProfileScreen {...base} resting onEndBreather={vi.fn()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("Coaching"),
      screen.getByText("Training"),
      screen.getByText("Bodyweight"),
      screen.getByText("On a breather"),
      screen.getByText("Account"),
      passkey,
    ]);
  });
});

describe("Profile: Your trainer row", () => {
  const row = (title) => screen.getByText(title).closest("a");

  it.each([
    ["sharing, live", share({ sharing: { ref: "g", name: "Jo", since: 1, live: true, looks: [], lookCount: 0 } }), "Jo", "Sees your training"],
    ["sharing, paused", share({ sharing: { ref: "g", name: "Jo", since: 1, live: false, looks: [], lookCount: 0 } }), "Jo", "Paused"],
    ["ended by the trainer", share({ ended: { name: "Max", at: Date.parse("2026-09-20T12:00:00Z"), by: "trainer" } }), "Max", /^Ended 20 Sept?$/],
    ["none, open", share(), "Add a trainer", "Type the code they show you"],
  ])("%s", async (_, trainerShare, title, sub) => {
    render(<ProfileScreen {...base} trainerShare={trainerShare} />);
    await screen.findByText("Passkey enabled");
    expect(row(title).getAttribute("href")).toBe("/profile/trainer");
    expect(row(title).textContent.replace(title, "")).toMatch(sub instanceof RegExp ? sub : new RegExp(`^${sub}$`));
  });

  it("shows nothing when signed out or offline, or when sharing isn't open and there is no trainer", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={null} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("Add a trainer")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ open: false })} />);
    expect(screen.queryByText("Add a trainer")).toBeNull();
    expect(screen.queryByText("Add a trainer")).toBeNull();
  });

  it("a trainer gets Your clients in a Trainer section after Coaching, and no For trainers row", async () => {
    at("2026-11-02");
    const { rerender } = render(<ProfileScreen {...base} trainerShare={share({ trainer: true })} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("Your clients")).toBeNull();
    expect(screen.queryByRole("group", { name: "Trainer" })).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true, trainer: true })} />);
    const section = screen.getByRole("group", { name: "Trainer" });
    expect(section.contains(row("Your clients"))).toBe(true);
    expect(row("Your clients").getAttribute("href")).toBe("/trainer");
    expect(row("Your clients").textContent.replace("Your clients", "")).toBe("See clients who share with you");
    expect(screen.getByRole("link", { name: "Your clients See clients who share with you" })).toBe(row("Your clients"));
    expect(screen.queryByText("For trainers")).toBeNull();
    expect(screen.queryByText("Set up as a trainer")).toBeNull();
    expectOrder([screen.getByText("Coaching"), screen.getByText("Talk it through"), screen.getByText("Add a trainer"),
      screen.getByText("Trainer"), screen.getByText("Your clients"), screen.getByText("Training"), screen.getByText("Account")]);
    // Its own block: nothing of Coaching inside it.
    expect(section.textContent).not.toMatch(/Talk it through|Add a trainer/);
  });

  it("a notice changes the Your clients words, not its place", async () => {
    render(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true, trainer: true })} noticeDots={{ clients: true }} />);
    await screen.findByText("Passkey enabled");
    expect(row("Your clients").textContent.replace("Your clients", "")).toBe("Something new from your clients");
    expect(screen.getByRole("group", { name: "Trainer" }).contains(row("Your clients"))).toBe(true);
    expectOrder([screen.getByText("Coaching"), screen.getByText("Trainer"), screen.getByText("Your clients"), screen.getByText("Training"), screen.getByText("Account")]);
  });

  it("everyone else gets For trainers as the last row of More, after Privacy, only when the trainer side is open", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={share()} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("For trainers")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true })} />);
    const forTrainers = row("For trainers");
    expect(forTrainers.getAttribute("href")).toBe("/trainer");
    expect(forTrainers.textContent.replace("For trainers", "")).toBe("Set up as a trainer");
    expect(screen.queryByText("Your clients")).toBeNull();
    const privacy = row("Privacy");
    expectOrder([screen.getByText("Coaching"), screen.getByText("Training"), screen.getByText("Account"),
      screen.getByText("More"), privacy, forTrainers]);
    // Nothing between Privacy and it: it is the next row, and the last link of More.
    expect(privacy.parentElement.nextElementSibling?.contains(forTrainers)).toBe(true);
    const links = [...document.querySelectorAll("a[href]")].filter((a) => before(screen.getByText("More"), a));
    expect(links.filter((a) => a.getAttribute("href").startsWith("/")).at(-1)).toBe(forTrainers);
  });
});

describe("Profile: For trainers, by application state", () => {
  const row = (title) => screen.getByText(title).closest("a");
  const sub = () => row("For trainers").textContent.replace("For trainers", "");
  const open = (over) => share({ trainerOpen: true, ...over });
  // A denial's wait: still running, and run out.
  const waiting = Date.now() + 5 * 864e5;
  const waited = Date.now() - 864e5;

  it.each([
    ["none", undefined, "Set up as a trainer"],
    ["withdrawn", { status: "withdrawn", at: 1, decidedAt: 2, nextAt: null, seen: false }, "Set up as a trainer"],
    ["applied", { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false }, "Application sent"],
    ["denied", { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: false }, "Not this time"],
    ["denied, its 30 days over", { status: "denied", at: 1, decidedAt: 2, nextAt: waited, seen: true }, "Set up as a trainer"],
    ["denied, no date left", { status: "denied", at: 1, decidedAt: 2, nextAt: null, seen: true }, "Set up as a trainer"],
  ])("%s", async (_, application, line) => {
    render(<ProfileScreen {...base} trainerShare={open({ application: application ?? null })} />);
    await screen.findByText("Passkey enabled");
    expect(sub()).toBe(line);
    expect(row("For trainers").getAttribute("href")).toBe("/trainer");
  });

  it("approved: the role moves the row to Your clients in the Trainer section", async () => {
    render(<ProfileScreen {...base} trainerShare={open({ trainer: true, trainerRole: true,
      application: { status: "approved", at: 1, decidedAt: 2, nextAt: null, seen: false } })} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("For trainers")).toBeNull();
    expect(row("Your clients").getAttribute("href")).toBe("/trainer");
    expect(screen.getByRole("group", { name: "Trainer" }).contains(row("Your clients"))).toBe(true);
  });

  const seenPosts = (spy) => spy.mock.calls.filter(([url, o]) => url === "/api/sync/trainer" && o?.method === "POST");

  it("opening it after a decision marks the decision seen, once per tap, for the caller's own profile", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ application: { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: false } })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("For trainers"));
      const calls = seenPosts(spy);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1].body)).toEqual({ profile: "sam", seenApplication: true });
    } finally { spy.mockRestore(); }
  });

  it("approved and unseen: opening Your clients marks it seen", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ trainer: true, application: { status: "approved", at: 1, decidedAt: 2, nextAt: null, seen: false } })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("Your clients"));
      expect(seenPosts(spy)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it.each([
    ["no application", null],
    ["applied", { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false }],
    ["a decision already seen", { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: true }],
  ])("%s: opening it writes nothing", async (_, application) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ application })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("For trainers"));
      expect(seenPosts(spy)).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});

describe("Profile: the Trainer section says what's new for a week", () => {
  const row = () => screen.getByText("Your clients").closest("a");
  const trainer = share({ trainerOpen: true, trainer: true });
  const tag = () => [...row().querySelectorAll("span")].find((el) => el.textContent === "New") ?? null;

  it.each([
    ["the day it shipped", "2026-10-06", true],
    ["six days on", "2026-10-12", true],
    ["seven days on", "2026-10-13", false],
    ["the day before", "2026-10-05", false],
  ])("%s (%s): New is %s", async (_, day, shown) => {
    at(day);
    render(<ProfileScreen {...base} trainerShare={trainer} />);
    await screen.findByText("Passkey enabled");
    expect(!!tag()).toBe(shown);
    expect(row().textContent).toBe(shown ? "Your clientsNewPer-lift ledger and CSV export" : "Your clientsSee clients who share with you");
    // The same row either way: same place, same link.
    expect(row().getAttribute("href")).toBe("/trainer");
    expect(screen.getByRole("group", { name: "Trainer" }).contains(row())).toBe(true);
  });

  it("the tag is quiet: tertiary ink, 11px, plain text", async () => {
    at("2026-10-06");
    render(<ProfileScreen {...base} trainerShare={trainer} />);
    await screen.findByText("Passkey enabled");
    expect(tag().getAttribute("style")).toBe("font-size: 11px; color: var(--ink-3);");
  });

  it("a waiting signal from clients takes the row: no New, the signal as the subline", async () => {
    at("2026-10-06");
    render(<ProfileScreen {...base} trainerShare={trainer} noticeDots={{ clients: true }} />);
    await screen.findByText("Passkey enabled");
    expect(tag()).toBeNull();
    expect(row().textContent).toBe("Your clientsSomething new from your clients");
  });

  it("stores nothing and writes nothing while it shows", async () => {
    at("2026-10-06");
    localStorage.clear();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={trainer} />);
      await screen.findByText("Passkey enabled");
      const keys = Object.keys(localStorage);
      fireEvent.click(row());
      expect(Object.keys(localStorage)).toEqual(keys);
      expect(keys.filter((k) => /news|ledger/i.test(k))).toEqual([]);
      expect(spy.mock.calls.filter(([url, o]) => url === "/api/sync/trainer" && o?.method === "POST")).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});

describe("Profile: nothing changes for someone who isn't a trainer", () => {
  // The markup of every row from the Coaching kicker up to the Training
  // kicker, and of the For trainers row: the Fade wrappers' contents, since
  // their own opacity depends on when the fade ran.
  const block = () => {
    const out = [];
    let el = screen.getByText("Coaching").closest("div").parentElement;
    for (; el && !el.textContent.startsWith("Training"); el = el.nextElementSibling) out.push(el.innerHTML);
    out.push(screen.getByText("For trainers").closest("a").parentElement.innerHTML);
    return out.join("\n");
  };
  const nonTrainer = share({ trainerOpen: true, sharing: { ref: "g", name: "Jo", since: 1, live: true, looks: [], lookCount: 0 },
    application: { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false } });

  it.each(["2026-10-05", "2026-10-06", "2026-10-12", "2026-10-13"])("same markup on %s, news window or not", async (day) => {
    at(day);
    render(<ProfileScreen {...base} trainerShare={nonTrainer} noticeDots={{ clients: true }} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByRole("group", { name: "Trainer" })).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
    expect(screen.queryByText("Your clients")).toBeNull();
    // Recorded before the Trainer section existed; it must not move.
    expect(block()).toMatchInlineSnapshot(`
      "<div style="margin-top: 36px; margin-bottom: 2px; font-size: 13px; color: var(--ink-3);">Coaching</div>
      <a href="/profile/coach" style="padding: 15px 2px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); display: flex; align-items: center; justify-content: space-between; text-decoration: none; color: inherit;"><div><div style="font-size: 15px; font-weight: 500; color: var(--ink);">Talk it through</div><div style="font-size: 12px; color: var(--ink-3); margin-top: 2px;">Your numbers, your AI</div></div><svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="display: inline-block; vertical-align: -0.125em; flex-shrink: 0;"><path d="M4.5 12 L19.5 12" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 6.5 L19.5 12 L14 17.5" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>
      <a href="/profile/trainer" style="padding: 15px 2px; border-bottom: 1px solid var(--rule); display: flex; align-items: center; justify-content: space-between; gap: 12px; text-decoration: none; color: inherit;"><div style="min-width: 0px;"><div style="font-size: 15px; font-weight: 500; color: var(--ink); overflow-wrap: anywhere;">Jo</div><div style="font-size: 12px; color: var(--ink-3); margin-top: 2px;">Sees your training</div></div><svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="display: inline-block; vertical-align: -0.125em; flex-shrink: 0;"><path d="M4.5 12 L19.5 12" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 6.5 L19.5 12 L14 17.5" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>
      <a href="/trainer" style="padding: 15px 2px; border-bottom: 1px solid var(--rule); display: flex; align-items: center; justify-content: space-between; text-decoration: none; color: inherit;"><div><div style="font-size: 15px; font-weight: 500; color: var(--ink);">For trainers</div><div style="font-size: 12px; color: var(--ink-3); margin-top: 2px;">Application sent</div></div><svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="display: inline-block; vertical-align: -0.125em; flex-shrink: 0;"><path d="M4.5 12 L19.5 12" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 6.5 L19.5 12 L14 17.5" fill="none" stroke="var(--ink-3)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>"
    `);
  });
});
