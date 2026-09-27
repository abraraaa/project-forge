// tests/db-insert-records.test.js
// Session records go in as one statement, skip id-less entries, never delete.
import { describe, it, expect } from "vitest";
import { dbInsertRecords } from "../lib/db.js";

const capture = () => {
  const calls = [];
  const q = (strings, ...values) => { calls.push({ text: strings.join("$"), values }); return Promise.resolve([]); };
  return { q, calls };
};

describe("dbInsertRecords", () => {
  it("inserts a batch in one statement, id-less records dropped", async () => {
    const { q, calls } = capture();
    await dbInsertRecords(q, "sam", [{ id: 1, a: 1 }, { a: 2 }, null, { id: "x", b: 3 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("jsonb_array_elements");
    expect(calls[0].text).toContain("ON CONFLICT (profile, id) DO NOTHING");
    expect(calls[0].text).not.toMatch(/DELETE|UPDATE/);
    expect(calls[0].values[0]).toBe("sam");
    expect(JSON.parse(calls[0].values[1])).toEqual([{ id: 1, a: 1 }, { id: "x", b: 3 }]);
  });
  it("issues nothing for an empty history", async () => {
    const { q, calls } = capture();
    await dbInsertRecords(q, "sam", []);
    await dbInsertRecords(q, "sam", undefined);
    expect(calls).toHaveLength(0);
  });
});
