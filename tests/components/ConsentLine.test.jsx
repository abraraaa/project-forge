// @vitest-environment jsdom
// The consent statement: exact copy, the /privacy link, and the id the
// consenting button points at.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ConsentLine from "../../components/ConsentLine.jsx";
import { CONSENT_COPY } from "../../lib/consent.js";

afterEach(cleanup);

describe("ConsentLine", () => {
  it("renders the exact line under the given id, and the small print with its link", () => {
    const { container } = render(<ConsentLine id="x" />);
    expect(screen.getByText(CONSENT_COPY.line).id).toBe("x");
    const a = screen.getByRole("link", { name: /^What we keep, and how to delete it/ });
    expect(a.getAttribute("href")).toBe("/privacy");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.textContent).toContain("(opens in a new tab)");
    const small = a.parentElement.textContent.replace(/\s+/g, " ").replace(" (opens in a new tab)", "").trim();
    expect(small).toBe("Over-18s only · What we keep, and how to delete it");
    expect(a.querySelector('span[style*="nowrap"]').textContent.trim()).toBe("it");
    expect(a.querySelector('span[style*="nowrap"] svg')).not.toBeNull();
    expect(container.textContent).not.toMatch(/server/i);
  });

  it("passes style through to the wrapper", () => {
    const { container } = render(<ConsentLine style={{ marginTop: 7 }} />);
    expect(/** @type {HTMLElement} */ (container.firstChild).style.marginTop).toBe("7px");
  });
});
