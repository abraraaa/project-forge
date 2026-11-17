// @vitest-environment jsdom
// A mid-session swap into a template-start lift with no working weight opens
// at that lift's own template weight, and the stepper moves it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, H, SessionIntent } from "../../lib/storage.js";
import { catalogueTemplateWeight } from "../../lib/programme-resolve.js";

afterEach(cleanup);

const WHO = "Tess";
const OHP = "Barbell Overhead Press";

// One earlier press: a Shoulders anchor.
const PRESS_DAY = {
  id: "2026-10-01T10:00:00.000Z", date: "2026-10-01", schemaVersion: 3, session: "strength-b", readiness: "normal",
  blocks: [{ id: "b2", type: "main", exercises: [{ name: OHP, loadType: "barbell", sets: [
    { weight: 50, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 50, est1rm: 58.3 },
  ] }] }],
};

function toLateralRaise(weights = {}) {
  P.setActive(WHO);
  P.saveWeights(WHO, weights);
  H.append(WHO, PRESS_DAY);
  SessionIntent.stash(WHO, { sessionIdx: 1 });
  render(<SessionHost />);
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  fireEvent.click(screen.getByLabelText("Open session overview"));
  const finisher = screen.getAllByRole("button").find((b) => /Lateral Raise/.test(b.textContent) && /Tricep Pushdown/.test(b.textContent));
  fireEvent.click(finisher);
  fireEvent.click(screen.getByText("Log A — into B"));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Lateral Raise");
}
const swapTo = (name) => {
  fireEvent.click(screen.getByText("Swap"));
  fireEvent.click(within(screen.getByRole("dialog")).getByText(name));
};
const shownKg = () => screen.getByText("kg", { selector: "span" }).previousSibling?.textContent ?? null;

describe("a swap into a template-start lift", () => {
  it("Lateral Raise to Cable Lateral Raise, an anchor and no logged weight: the card shows the template and the stepper moves it", () => {
    const template = catalogueTemplateWeight("Cable Lateral Raise", "total");
    expect(template).toBe(7);
    toLateralRaise({ [OHP]: 50 });
    swapTo("Cable Lateral Raise");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Cable Lateral Raise");
    expect(shownKg()).toBe("7");
    fireEvent.click(screen.getByLabelText("Add 2.5 kg"));
    expect(shownKg()).toBe("7.5");
    // Nothing is written to the stored working weights for it.
    expect(P.getWeights(WHO)).not.toHaveProperty("Cable Lateral Raise");
  });

  it("a logged working weight is untouched", () => {
    toLateralRaise({ [OHP]: 50, "Cable Lateral Raise": 12.5 });
    swapTo("Cable Lateral Raise");
    expect(shownKg()).toBe("12.5");
  });

  it("the template must be in the swapped lift's own load maths", () => {
    expect(catalogueTemplateWeight("Cable Lateral Raise", "per_db")).toBe(null);
    expect(catalogueTemplateWeight("Not A Lift", "total")).toBe(null);
  });
});
