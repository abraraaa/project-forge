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

  it("names the session analytics event while it carries readiness", () => {
    const host = read("components/SessionHost.jsx");
    if (/track\("session_complete"[\s\S]{0,200}readiness/.test(host)) {
      expect(page).toMatch(/readiness check-in\), through Vercel Web Analytics/);
    }
  });

  it("is linked from the sitemap", () => {
    expect(read("app/sitemap.js")).toContain("/privacy");
  });
});
