// @vitest-environment jsdom
// TabStrip: the house tabs. Roles and names a screen reader reads, one tab
// stop that moves with the arrow keys, and panels hidden but kept.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { TabStrip, TabPanel, tabIds } from "../../components/ui.jsx";
import { rovingIndex } from "../../lib/a11y.js";

afterEach(cleanup);

const TABS = [{ key: "plan", label: "Plan" }, { key: "sent", label: "Sent" }, { key: "lifts", label: "Lifts" }, { key: "sessions", label: "Sessions" }];

function Harness() {
  const [on, setOn] = useState("plan");
  return (
    <>
      <TabStrip label="Sam's training" idBase="t" tabs={TABS} selected={on} onSelect={setOn}/>
      {TABS.map((t) => (
        <TabPanel key={t.key} idBase="t" tabKey={t.key} selected={on === t.key}>
          <button type="button">{`In ${t.label}`}</button>
          <input aria-label={`Field in ${t.label}`}/>
        </TabPanel>
      ))}
    </>
  );
}

describe("TabStrip", () => {
  it("is a named tablist whose tabs control their panels, and each panel is named by its tab", () => {
    render(<Harness/>);
    const list = screen.getByRole("tablist", { name: "Sam's training" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Plan", "Sent", "Lifts", "Sessions"]);
    for (const [i, t] of tabs.entries()) {
      const ids = tabIds("t", TABS[i].key);
      expect(t.parentElement).toBe(list);
      expect(t.id).toBe(ids.tab);
      expect(t.getAttribute("aria-controls")).toBe(ids.panel);
      const panel = document.getElementById(ids.panel);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(ids.tab);
    }
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(screen.getByRole("tabpanel", { name: "Plan" })).toBeTruthy();
  });

  it("one tab stop: the current tab; a click moves it, and the panels follow", () => {
    render(<Harness/>);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    fireEvent.click(tabs[2]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(screen.getAllByRole("tabpanel").map((p) => p.getAttribute("aria-labelledby"))).toEqual(["t-tab-lifts"]);
    // The others are hidden, so nothing in them is reachable.
    expect(screen.queryByRole("button", { name: "In Plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "In Lifts" })).toBeTruthy();
  });

  it("Right and Left step and wrap, Home and End jump, focus and selection together; other keys do nothing", () => {
    render(<Harness/>);
    const tabs = screen.getAllByRole("tab");
    const at = () => [tabs.findIndex((t) => t === document.activeElement), tabs.findIndex((t) => t.getAttribute("aria-selected") === "true")];
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(at()).toEqual([1, 1]);
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(at()).toEqual([3, 3]);
    fireEvent.keyDown(tabs[3], { key: "ArrowRight" });
    expect(at()).toEqual([0, 0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(at()).toEqual([3, 3]);
    fireEvent.keyDown(tabs[3], { key: "Home" });
    expect(at()).toEqual([0, 0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowDown" });
    fireEvent.keyDown(tabs[0], { key: "a" });
    expect(at()).toEqual([0, 0]);
  });

  it("a hidden panel keeps what was typed in it", () => {
    render(<Harness/>);
    const field = /** @type {HTMLInputElement} */ (screen.getByLabelText("Field in Plan"));
    fireEvent.change(field, { target: { value: "105" } });
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(/** @type {HTMLInputElement} */ (screen.getByLabelText("Field in Plan")).value).toBe("105");
  });

  it("looks like the week strip: words, the current in ink with an ink underline, forge-press, 44 tall", () => {
    render(<Harness/>);
    const [on, off] = screen.getAllByRole("tab");
    for (const t of [on, off]) {
      expect(t.className).toBe("forge-press");
      expect(t.style.minHeight).toBe("44px");
    }
    expect([on.style.color, on.style.fontWeight]).toEqual(["var(--ink)", "500"]);
    expect([off.style.color, off.style.fontWeight]).toEqual(["var(--ink-2)", "400"]);
    const bar = (t) => /** @type {HTMLElement} */ (t.querySelector('[aria-hidden="true"]')).style.background;
    expect(bar(on)).toBe("var(--ink)");
    expect(bar(off)).toBe("transparent");
  });
});

describe("rovingIndex", () => {
  it("steps, wraps and jumps; null for other keys or no tabs", () => {
    expect(rovingIndex("ArrowRight", 0, 4)).toBe(1);
    expect(rovingIndex("ArrowRight", 3, 4)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(rovingIndex("Home", 2, 4)).toBe(0);
    expect(rovingIndex("End", 0, 4)).toBe(3);
    expect(rovingIndex("Enter", 0, 4)).toBeNull();
    expect(rovingIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
