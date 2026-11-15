// @vitest-environment jsdom
// Public server pages: the 404 sits in the content column, and the volume
// landmarks set MEV/MAV/MRV in the text face (mono is for numerals).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { T } from "../lib/tokens.js";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

import NotFound from "../app/not-found.jsx";
import VolumeLandmarksPage from "../app/volume-landmarks/page.jsx";

afterEach(cleanup);

describe("404", () => {
  it("is a centred 640px column with the house copy", () => {
    const { container } = render(<NotFound />);
    const col = /** @type {HTMLElement} */ (container.firstElementChild);
    expect(col.style.maxWidth).toBe("640px");
    expect(col.style.margin).toBe("0px auto");
    expect(screen.getByText("Error 404")).toBeTruthy();
    expect(container.textContent).toContain("This page doesn’t exist, or it moved.");
    expect(screen.getByRole("link").textContent).toBe("Take me home");
    expect(screen.getByRole("link").querySelector("svg")).toBeNull();
  });
});

describe("volume landmarks", () => {
  it("sets the three abbreviations in the text face, not mono", () => {
    render(<VolumeLandmarksPage />);
    for (const abbr of ["MEV", "MAV", "MRV"]) {
      const label = screen.getAllByText(abbr).find((el) => el.tagName === "SPAN");
      expect(label, abbr).toBeTruthy();
      expect(label.style.fontFamily).toBe(T.text);
      expect(label.style.fontFamily).not.toBe(T.measured);
      expect(label.style.fontWeight).toBe("500");
    }
  });
});
