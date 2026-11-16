// tests/next-config.test.js
// Next config facts the security posture depends on, read from the config
// object itself rather than its text.

import { describe, it, expect } from "vitest";
import nextConfig from "../next.config.mjs";

describe("next.config.mjs security posture", () => {
  it("images stay unoptimized, so /_next/image is not an open optimiser", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it("SVG is never allowed through the image pipeline", () => {
    expect(nextConfig.images).not.toHaveProperty("dangerouslyAllowSVG");
  });

  it("cacheComponents is off, top level and experimental", () => {
    expect(nextConfig).not.toHaveProperty("cacheComponents");
    expect(nextConfig.experimental ?? {}).not.toHaveProperty("cacheComponents");
  });
});
