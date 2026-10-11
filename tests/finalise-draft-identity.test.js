// tests/finalise-draft-identity.test.js
// finaliseDraft is pinned byte for byte, keys and order included, against
// output recorded before its summary block moved into summariseBlocks. The
// kept coached record is summarised by the same function, so this is the
// guard that the live log's records never moved.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { finaliseDraft, summariseBlocks } from "../lib/storage.js";
import { CASES, NOW_MS, serialise } from "./fixtures/finalise-draft-cases.js";

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(resolve(here, "fixtures/finalise-draft.json"), "utf8"));

afterEach(() => { vi.useRealTimers(); });

describe("finaliseDraft output is unchanged", () => {
  it("covers every recorded case", () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const name of Object.keys(CASES)) {
    it(name, () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      const draft = CASES[name]();
      const before = serialise(draft);
      expect(serialise(finaliseDraft(draft))).toBe(JSON.stringify(recorded[name], null, 2));
      // Pure: the draft it was handed is untouched.
      expect(serialise(draft)).toBe(before);
    });
  }
});

describe("summariseBlocks", () => {
  it("re-summarising a finalised record's blocks gives back the same blocks and summary", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    for (const name of Object.keys(CASES)) {
      const rec = finaliseDraft(CASES[name]());
      const again = summariseBlocks(rec.blocks);
      expect(serialise(again.blocks)).toBe(serialise(rec.blocks));
      expect(serialise(again.summary)).toBe(serialise(rec.summary));
    }
  });
});
