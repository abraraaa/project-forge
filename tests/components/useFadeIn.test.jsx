// @vitest-environment jsdom
// useFadeIn: the fade always runs; the 10px rise is skipped under
// prefers-reduced-motion.
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useFadeIn } from "../../components/ui.jsx";

const stubMotion = (reduce) =>
  vi.stubGlobal("matchMedia", (q) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)", media: q }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("useFadeIn", () => {
  it("rises and fades by default", () => {
    stubMotion(false);
    const { result } = renderHook(() => useFadeIn(0));
    expect(result.current.opacity).toBe(0);
    expect(result.current.transform).toBe("translateY(10px)");
    expect(result.current.transition).toContain("transform");
  });

  it("drops the rise but keeps the fade under reduced motion", () => {
    stubMotion(true);
    const { result } = renderHook(() => useFadeIn(0));
    expect(result.current.opacity).toBe(0);
    expect(result.current.transform).toBeUndefined();
    expect(result.current.transition).toMatch(/^opacity 260ms /);
    expect(result.current.transition).not.toContain("transform");
  });

  it("keeps the rise where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useFadeIn(0));
    expect(result.current.transform).toBe("translateY(10px)");
  });
});
