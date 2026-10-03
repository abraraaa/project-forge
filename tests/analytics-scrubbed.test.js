// Analytics never receives a URL fragment or a trainer code: beforeSend drops
// the fragment and replaces any code-shaped path or query part, and leaves
// every real route alone.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { mounted } = vi.hoisted(() => ({ mounted: [] }));
vi.mock("@vercel/analytics/next", () => ({
  Analytics: (props) => { mounted.push(props); return null; },
}));
vi.mock("@vercel/speed-insights/next", () => ({
  SpeedInsights: (props) => { mounted.push(props); return null; },
}));

import AnalyticsScrubbed, { scrubUrl, beforeSend } from "../components/AnalyticsScrubbed.jsx";
import { shareUrl, formatCode } from "@/lib/trainer-code";
import { LIBRARY, allTrainedMuscles, muscleSlug } from "@/lib/library";

const CODE = "ABCD0FGH1KMN";
const HOST = "https://heatwayve.app";

describe("scrubUrl", () => {
  it("drops the fragment of a share link", () => {
    expect(scrubUrl(shareUrl(CODE))).toBe(`${HOST}/share`);
    expect(scrubUrl(`${HOST}/share#abcd-0fgh-1kmn`)).toBe(`${HOST}/share`);
    expect(scrubUrl(`${HOST}/profile#anything`)).toBe(`${HOST}/profile`);
    expect(scrubUrl("/share#x")).toBe("/share");
  });

  it("replaces a code in the query, in every form it is shown or typed", () => {
    for (const form of [CODE, CODE.toLowerCase(), "abcdofghikmn", "abcd-0fgh-1kmn", encodeURIComponent(formatCode(CODE)), "ABCD+0FGH+1KMN", "abcd.ofgh.ikmn", "ABCD%C2%B70FGH%C2%B71KMN"]) {
      expect(scrubUrl(`${HOST}/share?c=${form}&x=1`), form).toBe(`${HOST}/share?c=[code]&x=1`);
      expect(scrubUrl(`${HOST}/share?${form}`), form).toBe(`${HOST}/share?[code]`);
    }
  });

  it("replaces a code in the path when it is 12 together, any case", () => {
    for (const form of [CODE, CODE.toLowerCase(), "abcdofghikmn"]) {
      expect(scrubUrl(`${HOST}/share/${form}`), form).toBe(`${HOST}/share/[code]`);
      expect(scrubUrl(`/${form}?x=1`), form).toBe("/[code]?x=1");
    }
  });

  it("leaves the host and every real route alone", () => {
    const routes = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== "api") walk(p); }
        else if (/^page\.jsx?$/.test(f)) routes.push("/" + path.relative("app", dir).split(path.sep).join("/"));
      }
    };
    walk("app");
    const slugs = [
      ...LIBRARY.map((e) => `/library/${e.slug}`),
      ...allTrainedMuscles().map((m) => `/anatomy/${muscleSlug(m)}`),
    ];
    expect(routes.length).toBeGreaterThan(10);
    expect(slugs.length).toBeGreaterThan(100);
    for (const r of [...routes, ...slugs, "/share", "/trainer", "/profile/trainer", "/?utm_source=qr"]) {
      expect(scrubUrl(`${HOST}${r}`)).toBe(`${HOST}${r}`);
    }
  });

  it("is not fooled by near misses: 11 or 13 characters, or a U", () => {
    for (const s of ["ABCD0FGH1KM", "ABCD0FGH1KMNP", "ABCD0FGH1KMU"]) {
      expect(scrubUrl(`${HOST}/x/${s}`)).toBe(`${HOST}/x/${s}`);
    }
  });

  it("passes anything that isn't a string through", () => {
    expect(scrubUrl(/** @type {any} */ (undefined))).toBe(undefined);
  });
});

describe("beforeSend", () => {
  it("keeps the event and scrubs only its url", () => {
    expect(beforeSend({ type: "pageview", url: shareUrl(CODE) })).toEqual({ type: "pageview", url: `${HOST}/share` });
    expect(beforeSend({ type: "event", url: `${HOST}/x?c=${CODE}` })).toEqual({ type: "event", url: `${HOST}/x?c=[code]` });
  });
});

describe("AnalyticsScrubbed", () => {
  it("mounts Vercel Analytics and Speed Insights, both with the scrubber", () => {
    mounted.length = 0;
    renderToStaticMarkup(createElement(AnalyticsScrubbed));
    expect(mounted).toHaveLength(2);
    for (const p of mounted) {
      expect(p.beforeSend({ type: "vital", url: "https://heatwayve.app/share#ABCD0FGH1KMN" }).url).toBe("https://heatwayve.app/share");
    }
  });

  it("the layout mounts the wrapper, never Analytics directly", () => {
    const layout = readFileSync("app/layout.jsx", "utf8");
    expect(layout).toMatch(/import AnalyticsScrubbed from "@\/components\/AnalyticsScrubbed"/);
    expect(layout).toMatch(/<AnalyticsScrubbed \/>/);
    expect(layout).not.toMatch(/@vercel\/analytics/);
    expect(layout).not.toMatch(/<Analytics[\s/>]/);
  });
});
