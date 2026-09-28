// @vitest-environment jsdom
// PressPoint — one document listener feeds the contact point (--x/--y) to
// every press surface, .forge-lift and .forge-tint alike, so a new button
// can't ship with its light centred. Pinned by behaviour: a press on a child
// resolves to the surface, other elements stay untouched, and unmount lets go.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PressPoint from "../../components/PressPoint.jsx";

afterEach(cleanup);

function Surfaces() {
  return (
    <>
      <PressPoint />
      <button className="forge-press forge-lift"><span>Lift label</span></button>
      <button className="forge-press forge-tint"><span>Tint label</span></button>
      <div className="plain"><span>Plain label</span></div>
    </>
  );
}

// jsdom lays nothing out; give the surface a box so the offset is checkable.
const placeAt = (el, left, top) => {
  el.getBoundingClientRect = () => ({ left, top, right: left + 100, bottom: top + 40, width: 100, height: 40, x: left, y: top, toJSON() {} });
};
const point = (el) => [el.style.getPropertyValue("--x"), el.style.getPropertyValue("--y")];

describe("PressPoint", () => {
  it("feeds --x/--y to the .forge-lift surface when its child is pressed", () => {
    render(<Surfaces />);
    const child = screen.getByText("Lift label");
    const lift = child.closest("button");
    placeAt(lift, 10, 20);
    fireEvent.pointerDown(child, { clientX: 50, clientY: 70 });
    expect(point(lift)).toEqual(["40px", "50px"]);
  });

  it("feeds the quiet .forge-tint surface from the same listener", () => {
    render(<Surfaces />);
    const child = screen.getByText("Tint label");
    const tint = child.closest("button");
    placeAt(tint, 100, 200);
    fireEvent.pointerDown(child, { clientX: 130, clientY: 215 });
    expect(point(tint)).toEqual(["30px", "15px"]);
  });

  it("leaves non-press elements untouched", () => {
    render(<Surfaces />);
    const child = screen.getByText("Plain label");
    const plain = child.closest("div");
    placeAt(plain, 0, 0);
    fireEvent.pointerDown(child, { clientX: 5, clientY: 5 });
    expect(point(plain)).toEqual(["", ""]);
    expect(point(child)).toEqual(["", ""]);
    const lift = screen.getByText("Lift label").closest("button");
    expect(point(lift)).toEqual(["", ""]);
  });

  it("removes its listener on unmount", () => {
    const { unmount } = render(<PressPoint />);
    unmount();
    const lift = document.createElement("button");
    lift.className = "forge-press forge-lift";
    document.body.appendChild(lift);
    placeAt(lift, 10, 20);
    fireEvent.pointerDown(lift, { clientX: 50, clientY: 70 });
    expect(point(lift)).toEqual(["", ""]);
    lift.remove();
  });
});
