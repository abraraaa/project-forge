// The AI's palette must be the app's palette. Every value is checked against
// app/globals.css, so a colour change there fails here until this follows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PALETTE, chartStyleText } from "../lib/chart-style.js";
import { handleMcp } from "../lib/mcp-server.js";

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
const cssName = (k) => "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/(\D)(\d)$/, "$1-$2");

describe("chart style mirrors globals.css", () => {
  it.each(Object.entries(PALETTE))("%s", (key, [light, dark]) => {
    const m = css.match(new RegExp(`${cssName(key)}:\\s*light-dark\\(([^,]+),\\s*(rgba\\([^)]*\\)|[^)]+)\\)`));
    expect(m, `${cssName(key)} not found in globals.css`).toBeTruthy();
    expect([m[1].trim(), m[2].trim()]).toEqual([light, dark]);
  });
});

describe("chart_style tool", () => {
  it("returns palette, type and the data-mark rules without reading training", async () => {
    let loads = 0;
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chart_style" } },
      { load: async () => { loads++; return null; } },
    );
    const t = r.result.content[0].text;
    expect(loads).toBe(0);
    expect(t).toContain("heat3: #A65340 (dark #D69A7A)");
    expect(t).toContain("Familjen Grotesk");
    expect(t).toMatch(/Past MRV is HATCHED/);
    expect(t).toBe(chartStyleText());
  });
  it("the server tells every AI to use it before drawing", async () => {
    const r = await handleMcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, { load: async () => null });
    expect(r.result.instructions).toContain("call chart_style");
  });
});
