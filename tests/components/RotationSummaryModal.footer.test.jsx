// @vitest-environment jsdom
// The rotation summary is a bottom sheet laid out as a flex column: a header,
// a scrolling list of swaps, a commit button. A long rotation squashed the
// button, because a flex item shrinks to its content unless told not to. The
// list is the only thing that shrinks; the footer keeps its height.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RotationSummaryModal } from "@/components/ForgeApp";

afterEach(cleanup);

const summary = (n) => ({
  blockNumber: 5,
  changes: Array.from({ length: n }, (_, i) => ({ slot: `ass${i}-A`, from: `Lift ${i}`, to: `Other lift ${i}` })),
  stimulusDelta: [],
  report: { outOfBand: [] },
});

describe("the rotation summary's footer", () => {
  it("the commit button keeps the house height however long the list", () => {
    render(<RotationSummaryModal summary={summary(14)} onContinue={() => {}} />);
    const button = screen.getByRole("button", { name: /Continue to readiness/ });
    expect(button.style.height).toBe("56px");
    expect(button.style.flexShrink).toBe("0");
  });

  it("a reset's summary closes with Done, same footer", () => {
    render(<RotationSummaryModal summary={{ ...summary(3), reason: "reset" }} onContinue={() => {}} />);
    const button = screen.getByRole("button", { name: "Done" });
    expect(button.style.flexShrink).toBe("0");
  });
});
