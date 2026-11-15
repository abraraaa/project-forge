// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The Locker Room page at the surface.
//
// Locks in:
//   - A failed upload or delete says a house line, never the server's or the
//     exception's words.
//   - A frame whose image is still in flight says "One moment", not blank.
//   - With no weights logged, "Log a weight" opens the bodyweight sheet and a
//     saved weight lands on the chart.
//
// next/navigation, the photo API and the auth session are mocked; storage is
// real (tests/setup.js clears it between tests) apart from the sync push.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/lib/auth-session", () => ({ ensurePhotoAccess: vi.fn() }));
vi.mock("@/lib/photos", () => ({
  preparePhoto: vi.fn(async () => new Blob(["x"], { type: "image/jpeg" })),
  uploadPhoto: vi.fn(),
  deletePhoto: vi.fn(),
  fetchPhotoIndex: vi.fn(),
  fetchPhotoObjectUrl: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal()),
  pushNow: vi.fn(async () => {}),
}));

import LockerRoom from "../../app/locker-room/page.jsx";
import { P, BW, pushNow } from "@/lib/storage";
import { ensurePhotoAccess } from "@/lib/auth-session";
import { uploadPhoto, deletePhoto } from "@/lib/photos";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RAW = "Raw words SENTINEL";

async function revealWith(photos) {
  ensurePhotoAccess.mockResolvedValueOnce({ token: "t", result: { ok: true, photos } });
  render(<LockerRoom />);
  await act(async () => { fireEvent.click(screen.getByText("Show photos")); });
}

describe("Locker room: failures speak house lines", () => {
  it.each([
    ["a server refusal", { ok: false, error: `Not a JPEG ${RAW}` }],
    ["an aborted request", { ok: false, error: `The operation was aborted. ${RAW}` }],
    ["an expired sign-in", { ok: false, error: RAW, requiresAuth: true }],
  ])("a failed upload (%s) says the house line", async (_, res) => {
    P.setActive("sam");
    uploadPhoto.mockResolvedValueOnce(res);
    await revealWith([]);
    const input = document.getElementById("scrub-photo-input");
    const file = new File(["x"], "me.jpg", { type: "image/jpeg" });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(await screen.findByText("That one didn't stick. Try it again?")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it.each([
    ["a server refusal", { ok: false, error: `Not found ${RAW}` }],
    ["an expired sign-in", { ok: false, error: RAW, requiresAuth: true }],
  ])("a failed delete (%s) says the house line", async (_, res) => {
    P.setActive("sam");
    deletePhoto.mockResolvedValueOnce(res);
    await revealWith([{ date: "2026-11-01", bodyweightAt: 80 }]);
    fireEvent.click(screen.getByText("Remove this photo"));
    await act(async () => { fireEvent.click(screen.getByText("Remove")); });
    expect(await screen.findByText("Couldn't remove it — try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
  });
});

describe("Locker room: a frame in flight", () => {
  it("says One moment while the image loads, not a blank card", async () => {
    P.setActive("sam");
    await revealWith([{ date: "2026-11-01", bodyweightAt: 80 }]);
    const status = screen.getByText("One moment").closest('[role="status"]');
    expect(status).toBeTruthy();
    expect(screen.queryByText(/Didn.t load/)).toBeNull();
  });
});

describe("Locker room: the empty bodyweight chart", () => {
  it("Log a weight opens the bodyweight sheet, and a saved weight lands on the chart", async () => {
    P.setActive("sam");
    render(<LockerRoom />);
    expect(screen.getByText(/Log a weight\. The line needs two points/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log a weight" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("Confirm")); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(BW.getKg("sam")).toBe(75);
    expect(pushNow).toHaveBeenCalledWith("sam");
    expect(screen.getByText("First point on the curve — the next one draws the line.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log a weight" })).toBeNull();
  });
});
