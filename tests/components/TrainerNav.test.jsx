// @vitest-environment jsdom
// The trainer and share pages' ways back, beyond /trainer itself (that one is
// in TrainerView.test.jsx): /share opens with "← Home", a link to /, in every
// state; and every back row on these surfaces draws its arrow in ink3, as
// Profile's "← Home" does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const { server } = vi.hoisted(() => ({ server: { peek: null, status: null } }));

vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url) => {
    const r = url === "/api/share/peek" ? server.peek : server.status;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  }),
}));

import ShareView from "../../components/ShareView.jsx";
import { P } from "@/lib/storage";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CODE = "ABCD0FGH1KMN";

beforeEach(() => {
  server.peek = { status: 200, body: { trainer: { name: "Jo" }, expiresAt: 1 } };
  server.status = { status: 401, body: {} };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function openShare(hash) {
  window.history.replaceState(null, "", `/share${hash}`);
  const r = render(<ShareView />);
  await act(async () => {});
  return r;
}

/** The page's first element: the house row, a link home. */
function expectHomeRow(container) {
  const page = container.firstElementChild;
  const row = page.firstElementChild;
  expect(row).toBe(screen.getByRole("link", { name: "Home" }));
  expect(row.getAttribute("href")).toBe("/");
  expect(row.style.color).toBe("var(--ink-2)");
  expect(row.style.fontSize).toBe("13px");
  expect(row.style.marginBottom).toBe("32px");
  expect(row.querySelector("svg path").getAttribute("stroke")).toBe("var(--ink-3)");
}

describe("/share: Home first on the page", () => {
  it("with no code", async () => {
    const { container } = await openShare("");
    expectHomeRow(container);
  });

  it("with a code, signed out", async () => {
    const { container } = await openShare(`#${CODE}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Jo's code");
    expectHomeRow(container);
  });

  it("with a code, signed in, at the approval: one way home", async () => {
    vi.spyOn(P, "getActive").mockReturnValue("sam");
    server.status = { status: 200, body: { open: true } };
    const { container } = await openShare(`#${CODE}`);
    await act(async () => {});
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Jo wants to see your training");
    expectHomeRow(container);
    expect(within(container).getAllByRole("link", { name: "Home" })).toHaveLength(1);
  });
});

describe("back rows on the trainer surfaces", () => {
  it.each(["components/TrainerView.jsx", "components/TrainerShareView.jsx", "components/ShareView.jsx"])(
    "%s: every arrow back is ink3", (p) => {
      const src = readFileSync(resolve(root, p), "utf8");
      const arrows = src.match(/<Glyph name="arrowLeft"[^>]*>/g) || [];
      expect(arrows.length).toBeGreaterThan(0);
      for (const a of arrows) expect(a).toContain("color={T.ink3}");
    });
});
