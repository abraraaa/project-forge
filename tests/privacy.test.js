// The privacy notice makes claims that live in code. If one of these fails,
// the code changed under the notice: update app/privacy/page.jsx with it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("privacy notice stays true", () => {
  const page = read("app/privacy/page.jsx");

  it("contact address is the live one", () => {
    expect(page).toContain('CONTACT = "ab@heatwayve.app"');
    expect(page).not.toMatch(/heatwayve\.com/);
  });

  it("server functions run in London, as stated", () => {
    expect(page).toMatch(/server functions that handle your data run in London/);
    expect(read("app/api/sync/route.js")).toContain('preferredRegion = "lhr1"');
  });

  it("video embeds use privacy-enhanced mode, as stated", () => {
    expect(page).toMatch(/privacy-enhanced mode/);
    for (const f of ["components/LibraryVideo.jsx", "components/SessionScreen.jsx"]) {
      const src = read(f);
      expect(src).not.toContain("www.youtube.com/embed/");
      if (src.includes("/embed/")) expect(src).toContain("www.youtube-nocookie.com/embed/");
    }
  });

  it("cookie lifetimes match the notice (sync 30 days, photos 7)", () => {
    expect(page).toMatch(/30 days \(sync\)/);
    expect(page).toMatch(/7 days \(photos\)/);
    expect(read("app/api/photos/route.js")).toContain("maxAge: 7 * 86400");
    expect(read("app/api/sync/route.js")).toContain("maxAge: 30 * 86400");
  });

  it("analytics carry no health data, as stated", () => {
    for (const f of ["components/SessionHost.jsx", "components/ForgeApp.jsx"]) {
      const calls = read(f).match(/track\("session_complete"[^)]*\)/g) || [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c).not.toMatch(/readiness|bodyweight/i);
    }
  });

  it("bodyweight stays out of the photo upload URL", () => {
    expect(read("lib/photos.js")).not.toMatch(/params\.set\("bw"/);
    expect(read("app/api/photos/route.js")).toContain('request.headers.get("x-hw-bodyweight")');
  });

  it("is linked from the sitemap", () => {
    expect(read("app/sitemap.js")).toContain("/privacy");
  });
});
