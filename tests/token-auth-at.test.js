// The sliding sync/photo cookies are capped from the ORIGINAL passkey
// ceremony (authAt). That cap only works if authAt survives the database
// round trip — it used to be dropped on insert, so rotation reset it forever.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const db = readFileSync(resolve(__dirname, "../lib/db.js"), "utf8");

describe("auth_at survives the token table", () => {
  it("adds the column additively", () => {
    expect(db).toContain("ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS auth_at TIMESTAMPTZ");
  });
  it("writes authAt on insert", () => {
    expect(db).toMatch(/dbInsertToken\(token, \{[^}]*authAt = null \}\)/);
    expect(db).toMatch(/INSERT INTO auth_tokens \([^)]*auth_at\)[\s\S]{0,200}\$\{authAt\}\)/);
  });
  it("reads authAt back", () => {
    expect(db).toMatch(/SELECT profile, expires, scope, created_at, auth_at FROM auth_tokens/);
    expect(db).toMatch(/authAt: r\.auth_at/);
  });
  it("both rotation paths carry it forward and measure the cap from it", () => {
    for (const f of ["app/api/sync/route.js", "app/api/photos/route.js"]) {
      const src = readFileSync(resolve(__dirname, "..", f), "utf8");
      expect(src).toContain("authAt: data.authAt || data.createdAt || null");
      expect(src).toMatch(/new Date\(data\.authAt \|\| data\.createdAt/);
    }
  });
});
