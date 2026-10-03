// @vitest-environment jsdom
// ShareView (/share): where a trainer's link lands. The code is read from the
// fragment and the fragment dropped; "Copy code" carries it to the app; the
// approval shows only when this browser is signed in and may add a trainer.
// ShareApprove is stubbed: it has its own tests.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { server } = vi.hoisted(() => ({
  server: { peek: null, status: null, calls: [], mounts: 0 },
}));

vi.mock("@/components/ShareApprove", async (importOriginal) => {
  const { useState } = await import("react");
  // data-mount: which mount this is, so a fresh approval shows as a new number.
  function Stub(props) {
    const [mount] = useState(() => ++server.mounts);
    return (
      <div data-testid="share-approve" data-name={props.name} data-code={props.code} data-mount={mount}>
        <button type="button" onClick={() => props.onApproved?.()}>stub: approved</button>
      </div>
    );
  }
  return { ...(await importOriginal()), default: Stub };
});
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts) => {
    server.calls.push({ url, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    if (url === "/api/share/peek") {
      const r = server.peek;
      return r instanceof Error ? Promise.reject(r) : { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
    const r = server.status;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  }),
}));

import ShareView, { SHARE_PAGE_COPY } from "../../components/ShareView.jsx";
import { APPROVE_COPY } from "@/components/ShareApprove";
import { P } from "@/lib/storage";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CODE = "ABCD0FGH1KMN";
const hit = (name = "Jo") => ({ status: 200, body: { trainer: { name }, expiresAt: 1 } });
const MISS = { status: 404, body: { error: SHARE_PAGE_COPY.miss } };
const signedIn = (over = {}) => ({ status: 200, body: { open: true, trainerOpen: false, trainer: false, sharing: null, ended: null, ...over } });
const SIGNED_OUT = { status: 401, body: { error: "Sign in to see your trainer", requiresAuth: true } };

beforeEach(() => {
  server.peek = hit();
  server.status = SIGNED_OUT;
  server.calls = [];
  server.mounts = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

// Open /share with this fragment, render, and let every fetch land.
async function openShare(hash) {
  window.history.replaceState(null, "", `/share${hash}`);
  render(<ShareView />);
  await act(async () => {});
}

describe("ShareView: the code from the link", () => {
  it("reads the code from the fragment, then drops the fragment", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    await openShare("#abcd-0fgh-1kmn");
    expect(screen.getByText("ABCD 0FGH 1KMN")).toBeTruthy();
    expect(replace).toHaveBeenCalledWith(null, "", "/share");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/share");
  });

  it("folds a typed-looking code: lowercase, spaces, O and I", async () => {
    await openShare("#abcd%20ofgh%20ikmn");
    expect(screen.getByText("ABCD 0FGH 1KMN")).toBeTruthy();
    expect(server.calls.find((c) => c.url === "/api/share/peek").body).toEqual({ code: CODE });
  });

  it("peeks once and names the trainer; before that, the heading is generic", async () => {
    let answer;
    server.peek = { status: 200, body: null };
    const { fetchWithTimeout } = await import("@/lib/net");
    vi.mocked(fetchWithTimeout).mockImplementationOnce(async (url, opts) => {
      server.calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      return new Promise((r) => { answer = r; });
    });
    await openShare(`#${CODE}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your trainer's code");
    await act(async () => answer({ ok: true, status: 200, json: async () => hit("Sam Hale").body }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sam Hale's code");
    expect(server.calls.filter((c) => c.url === "/api/share/peek")).toEqual([{ url: "/api/share/peek", method: "POST", body: { code: CODE } }]);
  });

  it("shows the steps to finish in the app", async () => {
    await openShare(`#${CODE}`);
    const steps = screen.getByRole("list", { name: "In the app" });
    expect([...steps.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Open Heatwayve.",
      "Go to Profile, then Add a trainer.",
      "Paste or type the code, and approve with Face ID.",
    ]);
  });

  it("Copy code writes the code to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openShare("#abcd-0fgh-1kmn");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    // Said in the status line too, so a screen reader hears it.
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("says so when the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
    await openShare(`#${CODE}`);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
    expect(screen.getByText(SHARE_PAGE_COPY.copyFailed)).toBeTruthy();
  });

  it("a miss shows the miss copy, keeps the steps, and offers no approval", async () => {
    P.setActive("sam");
    server.peek = MISS;
    server.status = signedIn();
    await openShare(`#${CODE}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your trainer's code");
    expect(screen.getByText(SHARE_PAGE_COPY.miss)).toBeTruthy();
    expect(screen.getByRole("list", { name: "In the app" })).toBeTruthy();
    expect(screen.queryByTestId("share-approve")).toBeNull();
  });

  it("offline peek keeps the generic heading and the steps, with no miss copy", async () => {
    server.peek = new Error("offline");
    await openShare(`#${CODE}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your trainer's code");
    expect(screen.queryByText(SHARE_PAGE_COPY.miss)).toBeNull();
    expect(screen.getByRole("list", { name: "In the app" })).toBeTruthy();
  });
});

describe("ShareView: another link while the page is open", () => {
  it("a hashchange reads the new code, peeks it, and drops the fragment again", async () => {
    await openShare(`#${CODE}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Jo's code");
    server.peek = hit("Kim");
    await act(async () => {
      window.history.replaceState(null, "", "/share#zzzz-0fgh-1kmn");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByText("ZZZZ 0FGH 1KMN")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Kim's code");
    expect(server.calls.filter((c) => c.url === "/api/share/peek").map((c) => c.body)).toEqual([{ code: CODE }, { code: "ZZZZ0FGH1KMN" }]);
    expect(window.location.hash).toBe("");
  });

  it("the same link opened again peeks again, keeps the name, and starts a fresh approval", async () => {
    P.setActive("sam");
    server.status = signedIn();
    await openShare(`#${CODE}`);
    expect(screen.getByTestId("share-approve").dataset.mount).toBe("1");
    await act(async () => { fireEvent.click(screen.getByText("stub: approved")); });
    expect(screen.queryByText("ABCD 0FGH 1KMN")).toBeNull();
    await act(async () => {
      window.history.replaceState(null, "", `/share#${CODE}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Jo's code");
    expect(screen.getByText("ABCD 0FGH 1KMN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    // A new approval for the new link, not the finished one.
    expect(screen.getByTestId("share-approve").dataset.mount).toBe("2");
    expect(server.calls.filter((c) => c.url === "/api/share/peek")).toHaveLength(2);
    expect(window.location.hash).toBe("");
  });
});

describe("ShareView: finishing here", () => {
  it("once approved here, the used code, Copy code and the in-app steps go", async () => {
    P.setActive("sam");
    server.status = signedIn();
    await openShare(`#${CODE}`);
    expect(screen.getByText("ABCD 0FGH 1KMN")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("stub: approved")); });
    expect(screen.queryByText("ABCD 0FGH 1KMN")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
    expect(screen.queryByRole("list", { name: "In the app" })).toBeNull();
    expect(screen.queryByText(/Or share from here/)).toBeNull();
    // The approval stays, on its done step.
    expect(screen.getByTestId("share-approve")).toBeTruthy();
  });

  it("shows the approval when this browser is signed in and may add a trainer", async () => {
    P.setActive("sam");
    server.status = signedIn();
    await openShare(`#${CODE}`);
    const approve = screen.getByTestId("share-approve");
    expect(approve.dataset.name).toBe("sam");
    expect(approve.dataset.code).toBe(CODE);
    expect(screen.getByText("Or share from here, as sam")).toBeTruthy();
    expect(server.calls).toContainEqual({ url: "/api/sync/trainer?profile=sam", method: "GET", body: null });
  });

  it("no active profile: no approval, and no status check", async () => {
    server.status = signedIn();
    await openShare(`#${CODE}`);
    expect(screen.queryByTestId("share-approve")).toBeNull();
    expect(screen.queryByText(/Or share from here/)).toBeNull();
    expect(server.calls.map((c) => c.url)).toEqual(["/api/share/peek"]);
  });

  it("an active profile this browser isn't signed in as: no approval", async () => {
    P.setActive("sam");
    server.status = SIGNED_OUT;
    await openShare(`#${CODE}`);
    expect(screen.queryByTestId("share-approve")).toBeNull();
  });

  it("signed in, but adding a trainer isn't open to this account yet: no approval", async () => {
    P.setActive("sam");
    server.status = signedIn({ open: false });
    await openShare(`#${CODE}`);
    expect(screen.queryByTestId("share-approve")).toBeNull();
  });
});

describe("ShareView: copy", () => {
  it("the miss line is the approval's own, not a copy of it", () => {
    expect(SHARE_PAGE_COPY.miss).toBe(APPROVE_COPY.miss);
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../components/ShareView.jsx"), "utf8");
    expect(src).not.toContain("That code didn't work");
  });
});

describe("ShareView: no code", () => {
  it("asks for one and points to the app, fetching nothing", async () => {
    P.setActive("sam");
    server.status = signedIn();
    await openShare("");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Got a code?");
    expect(screen.getByText("Type it in the app: Profile, then Add a trainer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
    expect(screen.queryByTestId("share-approve")).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("a fragment that isn't a code is dropped all the same", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    await openShare("#ABCDEFGHJKMU");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Got a code?");
    expect(replace).toHaveBeenCalledWith(null, "", "/share");
    expect(window.location.hash).toBe("");
  });
});
