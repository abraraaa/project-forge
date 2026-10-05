// @vitest-environment jsdom
// The three first-run steps: each opens on the current choice, Keep moves on
// without a change, a pick reports the right value, and Days shows the
// letters and the per-count note.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import FocusStep from "@/components/first-run/FocusStep";
import MainLiftsStep from "@/components/first-run/MainLiftsStep";
import DaysStep from "@/components/first-run/DaysStep";
import { WEEK, FOCUS_SUMMARIES, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS } from "@/lib/programme";

afterEach(cleanup);

const pressed = (name) => screen.getByRole("button", { name, pressed: true });

describe("FocusStep", () => {
  it("marks the current focus and Keep moves on without a change", () => {
    const onChange = vi.fn(), onNext = vi.fn();
    render(<FocusStep value="Forged" onChange={onChange} onNext={onNext} />);
    expect(pressed(/^Forged/)).toBeTruthy();
    for (const f of ["Forged", "Strong", "Sculpt"]) expect(screen.getByText(FOCUS_SUMMARIES[f])).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Forged" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("re-tapping the current focus is not a change", () => {
    const onChange = vi.fn();
    render(<FocusStep value="Forged" onChange={onChange} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Forged/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a pick reports the focus and the button keeps the new one", () => {
    const onChange = vi.fn(), onNext = vi.fn();
    function Host() {
      const [v, setV] = useState("Forged");
      return <FocusStep value={v} onChange={(f) => { onChange(f); setV(f); }} onNext={onNext} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: /^Sculpt/ }));
    expect(onChange).toHaveBeenCalledWith("Sculpt");
    expect(onNext).not.toHaveBeenCalled();
    expect(pressed(/^Sculpt/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Sculpt" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

const DEFAULT_LIFTS = Object.fromEntries(Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).map((k) => [k, k]));

describe("MainLiftsStep", () => {
  it("lists the five slots with their lifts and Keep these moves on without a change", () => {
    const onChange = vi.fn(), onNext = vi.fn();
    render(<MainLiftsStep mainLifts={DEFAULT_LIFTS} onChange={onChange} onNext={onNext} />);
    for (const lift of Object.keys(DEFAULT_LIFTS)) expect(screen.getByText(lift)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Change / })).toHaveLength(5);
    expect(screen.getByText(/Five lifts carry your progression/)).toBeTruthy();
    expect(screen.getByText(/Change one only with a reason/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep these" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Change opens that slot's equivalents with the default marked", () => {
    render(<MainLiftsStep mainLifts={DEFAULT_LIFTS} onChange={vi.fn()} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Quads" }));
    const list = document.getElementById(screen.getByRole("button", { name: "Done Quads" }).getAttribute("aria-controls"));
    const chips = within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(chips).toEqual(["Barbell Back Squat, programme default", "Front Squat", "Hack Squat"]);
    expect(within(list).getByRole("button", { name: "Barbell Back Squat, programme default", pressed: true })).toBeTruthy();
  });

  it("a pick reports slot and lift, and re-picking the current lift does not", () => {
    const onChange = vi.fn();
    render(<MainLiftsStep mainLifts={DEFAULT_LIFTS} onChange={onChange} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Quads" }));
    fireEvent.click(screen.getByRole("button", { name: "Barbell Back Squat, programme default" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change Quads" }));
    fireEvent.click(screen.getByRole("button", { name: "Front Squat" }));
    expect(onChange).toHaveBeenCalledWith("Barbell Back Squat", "Front Squat");
    expect(screen.queryByRole("button", { name: "Hack Squat" })).toBeNull(); // closed after the pick
  });

  it("shows a swapped lift in its slot", () => {
    render(<MainLiftsStep mainLifts={{ ...DEFAULT_LIFTS, "Hex Bar Deadlift": "Sumo Deadlift" }} onChange={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByText("Sumo Deadlift")).toBeTruthy();
    expect(screen.queryByText("Hex Bar Deadlift")).toBeNull();
  });
});

function DaysHost({ initial = WEEK, todayIdx = 0, onChange = vi.fn(), onNext = vi.fn() }) {
  const [w, setW] = useState(initial);
  return <DaysStep week={w} todayIdx={todayIdx} onChange={(n) => { onChange(n); setW(n); }} onNext={onNext} />;
}
const day = (name) => screen.getByRole("button", { name: new RegExp(`^${name},`) });
const lettersShown = () => [...document.querySelectorAll("[data-letter]")].map((n) => n.textContent).join("");

describe("DaysStep", () => {
  it("opens on Mon, Wed, Fri with A, B, C under them; Keep moves on without a change", () => {
    const onChange = vi.fn(), onNext = vi.fn();
    render(<DaysHost onChange={onChange} onNext={onNext} />);
    expect(day("Monday").getAttribute("aria-label")).toBe("Monday, Strength A");
    expect(day("Wednesday").getAttribute("aria-label")).toBe("Wednesday, Strength B");
    expect(day("Friday").getAttribute("aria-label")).toBe("Friday, Strength C");
    expect(day("Tuesday").getAttribute("aria-pressed")).toBe("false");
    expect(lettersShown()).toBe("ABC");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep 3 days" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("projects A onto the first strength day from today", () => {
    render(<DaysHost todayIdx={3} />);
    expect(day("Friday").getAttribute("aria-label")).toBe("Friday, Strength A");
    expect(day("Monday").getAttribute("aria-label")).toBe("Monday, Strength B");
  });

  it("moving Monday to Tuesday swaps their types and keeps A, B, C in order", () => {
    const onChange = vi.fn();
    render(<DaysHost onChange={onChange} />);
    fireEvent.click(day("Monday"));
    fireEvent.click(day("Tuesday"));
    const last = onChange.mock.calls.at(-1)[0];
    expect(last.map((d) => d.type)).toEqual(["zone2", "strength", "strength", "cardio", "strength", "hiit", "rest"]);
    expect(day("Tuesday").getAttribute("aria-label")).toBe("Tuesday, Strength A");
    expect(day("Monday").getAttribute("aria-label")).toBe("Monday, Zone 2");
    expect(screen.getByRole("button", { name: "Keep 3 days" })).toBeTruthy();
  });

  it("toggling back hands the opening week back unchanged", () => {
    const onChange = vi.fn();
    render(<DaysHost onChange={onChange} />);
    fireEvent.click(day("Monday"));
    fireEvent.click(day("Monday"));
    expect(onChange.mock.calls.at(-1)[0]).toBe(WEEK);
  });

  it("shows the note for one, two and four days", () => {
    render(<DaysHost />);
    fireEvent.click(day("Saturday"));
    expect(screen.getByRole("status").textContent).toMatch(/^Four days: the round comes back within the week/);
    expect(screen.getByRole("button", { name: "Keep 4 days" })).toBeTruthy();
    expect(lettersShown()).toBe("ABCA");
    fireEvent.click(day("Saturday"));
    fireEvent.click(day("Friday"));
    expect(screen.getByRole("status").textContent).toMatch(/^Two days: a full A, B, C round takes a week and a half/);
    expect(screen.getByRole("button", { name: "Keep 2 days" })).toBeTruthy();
    fireEvent.click(day("Wednesday"));
    expect(screen.getByRole("status").textContent).toBe("One day: a full round takes three weeks. Progress will be slow.");
    expect(screen.getByRole("button", { name: "Keep 1 day" })).toBeTruthy();
  });

  it("with no days, asks for one and cannot move on", () => {
    const onNext = vi.fn();
    render(<DaysHost onNext={onNext} />);
    for (const d of ["Monday", "Wednesday", "Friday"]) fireEvent.click(day(d));
    expect(screen.getByRole("status").textContent).toBe("Pick at least one.");
    const btn = screen.getByRole("button", { name: "Pick a day" });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onNext).not.toHaveBeenCalled();
  });
});
