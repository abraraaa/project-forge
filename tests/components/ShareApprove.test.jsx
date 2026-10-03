// @vitest-environment jsdom
// ShareApprove: the one approval surface. Typed, spaced or pasted codes all
// peek; a miss keeps the text; the client's name is read at tap; a current
// trainer is never replaced without "Switch", which reuses the same Face ID;
// a cancelled ceremony goes back to idle without a word.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { server } = vi.hoisted(() => ({ server: { peek: null, approve: [] } }));

vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => ({ authToken: "tok-1" })) }));
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts) => {
    const reply = url === "/api/share/peek" ? server.peek : server.approve.shift();
    const [status, body] = reply || [500, {}];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }),
}));

import ShareApprove from "../../components/ShareApprove.jsx";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";
import { SHARE_COPY, SHARE_CONSENT_VERSION } from "@/lib/trainer-terms";
import { shareUrl } from "@/lib/trainer-code";

const CODE = "ABCD0EFGH1JK";
const HIT = [200, { trainer: { name: "Jo" }, expiresAt: 1 }];
const MISS = [404, { error: "That code didn't work. Check it, or ask your trainer for a fresh one." }];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  server.peek = null;
  server.approve = [];
});

const calls = (path) => fetchWithTimeout.mock.calls.filter(([u]) => u === path).map(([, o]) => JSON.parse(o.body));
const field = () => screen.getByLabelText("The code your trainer showed you");
async function type(text) {
  await act(async () => { fireEvent.change(field(), { target: { value: text } }); });
}
async function tap(text) {
  await act(async () => { fireEvent.click(screen.getByText(text)); });
}

describe("ShareApprove: the code", () => {
  it("a pasted share link peeks with its code", async () => {
    server.peek = HIT;
    render(<ShareApprove name="sam" />);
    await type(shareUrl(CODE));
    expect(calls("/api/share/peek")).toEqual([{ code: CODE }]);
    expect(screen.getByText("Jo wants to see your training")).toBeTruthy();
  });

  it("a spaced lowercase code, with O and l typed for 0 and 1, peeks the same code", async () => {
    server.peek = HIT;
    render(<ShareApprove name="sam" />);
    await type("abcd oefg h1j");
    expect(calls("/api/share/peek")).toEqual([]);   // 11 characters: nothing yet
    await type("abcd oefg hljk");
    expect(calls("/api/share/peek")).toEqual([{ code: CODE }]);
  });

  it("shows the code grouped as it is typed", async () => {
    render(<ShareApprove name="sam" />);
    await type("abcd-e");
    expect(field().value).toBe("ABCD E");
    expect(screen.getByText("Next").closest("button").disabled).toBe(true);
  });

  it("a peek miss says so under the field and keeps the text", async () => {
    server.peek = MISS;
    render(<ShareApprove name="sam" />);
    await type("abcd 0efg h1jk");
    expect(screen.getByText(MISS[1].error)).toBeTruthy();
    expect(field().value).toBe("ABCD 0EFG H1JK");
    expect(screen.queryByText(/wants to see your training/)).toBeNull();
    // Next tries the same code again.
    server.peek = HIT;
    await tap("Next");
    expect(calls("/api/share/peek")).toHaveLength(2);
    expect(screen.getByText("Jo wants to see your training")).toBeTruthy();
  });
});

describe("ShareApprove: the code, limits", () => {
  it("the per-IP limit at peek reads in the house voice", async () => {
    server.peek = [429, { error: "Too many requests" }];
    render(<ShareApprove name="sam" />);
    await type(CODE);
    expect(screen.getByText("Too many tries. Wait a minute and try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Too many requests");
  });
});

describe("ShareApprove: approval", () => {
  async function toApprove(props = {}) {
    server.peek = HIT;
    const view = render(<ShareApprove name="sam" {...props} />);
    await type(CODE);
    return view;
  }

  it("shows the fixed share rows, no switches, and the in-app name line", async () => {
    await toApprove();
    for (const row of SHARE_COPY.rows) expect(screen.getByText(row)).toBeTruthy();
    expect(screen.getByText(SHARE_COPY.includes)).toBeTruthy();
    expect(screen.getByText(SHARE_COPY.line)).toBeTruthy();
    expect(screen.getByText("You'll approve as sam with Face ID.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toContain("How you felt each session");
    expect(screen.getByText("Share with Jo").closest("button").getAttribute("aria-describedby")).toBe("share-line");
  });

  it("reads the name at tap, runs the quiet ceremony, and posts the approval", async () => {
    const { rerender } = await toApprove();
    rerender(<ShareApprove name="alex" />);
    server.approve = [[200, { ok: true, trainer: { name: "Jo" }, replaced: null }]];
    await tap("Share with Jo");
    expect(authenticatePasskey).toHaveBeenCalledWith("alex", { quiet: true });
    expect(calls("/api/share/approve")).toEqual([
      { code: CODE, authToken: "tok-1", profile: "alex", consent: { version: SHARE_CONSENT_VERSION } },
    ]);
    expect(screen.getByText("Jo can see your training.")).toBeTruthy();
    expect(screen.getByText("Read only. Stop any time in Profile.")).toBeTruthy();
  });

  it("a cancelled Face ID goes back to idle, says nothing and posts nothing", async () => {
    await toApprove();
    authenticatePasskey.mockResolvedValueOnce(null);
    await tap("Share with Jo");
    expect(calls("/api/share/approve")).toEqual([]);
    expect(screen.getByText("Share with Jo")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("asks before replacing a current trainer, then switches with the same token", async () => {
    const onDone = vi.fn();
    await toApprove({ onDone });
    server.approve = [
      [409, { replaces: { name: "Max" } }],
      [200, { ok: true, trainer: { name: "Jo" }, replaced: { name: "Max" } }],
    ];
    await tap("Share with Jo");
    expect(screen.getByText("You share with Max now. Switch to Jo?")).toBeTruthy();
    expect(screen.getByText("Keep Max")).toBeTruthy();
    await tap("Switch");
    expect(authenticatePasskey).toHaveBeenCalledTimes(1);
    const [first, second] = calls("/api/share/approve");
    expect(first.replace).toBeUndefined();
    expect(second).toEqual({ ...first, replace: true });
    await tap("Done");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("the Switch commit carries the share line too", async () => {
    await toApprove();
    server.approve = [[409, { replaces: { name: "Max" } }]];
    await tap("Share with Jo");
    expect(screen.getByText(SHARE_COPY.line).id).toBe("share-line");
    expect(screen.getByText("Switch").closest("button").getAttribute("aria-describedby")).toBe("share-line");
  });

  it("each step takes focus, and onApproved fires once the share is live", async () => {
    const onApproved = vi.fn();
    await toApprove({ onApproved });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Jo wants to see your training" }));
    server.approve = [[409, { replaces: { name: "Max" } }]];
    await tap("Share with Jo");
    expect(document.activeElement).toBe(screen.getByText("You share with Max now. Switch to Jo?"));
    await tap("Keep Max");
    expect(document.activeElement).toBe(screen.getByText("Share with Jo").closest("button"));
    expect(onApproved).not.toHaveBeenCalled();
    server.approve = [[200, { ok: true }]];
    await tap("Share with Jo");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Jo can see your training." }));
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("Keep drops the held token: sharing again asks for Face ID again", async () => {
    await toApprove();
    server.approve = [[409, { replaces: { name: "Max" } }]];
    await tap("Share with Jo");
    await tap("Keep Max");
    expect(screen.queryByText("Switch")).toBeNull();
    server.approve = [[200, { ok: true }]];
    await tap("Share with Jo");
    expect(authenticatePasskey).toHaveBeenCalledTimes(2);
    expect(calls("/api/share/approve").every((b) => b.replace === undefined)).toBe(true);
  });

  it.each([
    [[429, { error: "Too many tries. Ask your trainer for a fresh code, then try again in an hour." }], "Too many tries. Ask your trainer for a fresh code, then try again in an hour."],
    [[429, { error: "Too many requests" }], "Too many tries. Wait a minute and try again."],
    [[409, { self: true, error: "That's your own code." }], "That's your own code."],
    [[409, { needsNativePasskey: true }], "This needs a passkey for heatwayve.app first."],
    [[400, { stale: true, error: "This page is out of date. Reload and try again." }], "This page is out of date. Reload and try again."],
    [[401, { error: "Face ID didn't go through. Try again.", requiresAuth: true }], "Face ID didn't go through. Try again."],
  ])("says why an approval failed (%j)", async (reply, copy) => {
    await toApprove();
    server.approve = [reply];
    await tap("Share with Jo");
    expect(screen.getByRole("status").textContent).toBe(copy);
    expect(screen.getByText("Share with Jo")).toBeTruthy();
  });

  it("a code used up since the peek goes back to the field, text kept", async () => {
    await toApprove();
    server.approve = [MISS];
    await tap("Share with Jo");
    expect(field().value).toBe("ABCD 0EFG H1JK");
    expect(screen.getByText(MISS[1].error)).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  it("with a code in hand: no field, a peek on mount, no in-app name line", async () => {
    server.peek = HIT;
    await act(async () => { render(<ShareApprove name="sam" code={CODE.toLowerCase()} />); });
    expect(screen.queryByLabelText("The code your trainer showed you")).toBeNull();
    expect(calls("/api/share/peek")).toEqual([{ code: CODE }]);
    expect(screen.getByText("Share with Jo")).toBeTruthy();
    expect(screen.queryByText(/You'll approve as/)).toBeNull();
  });
});
