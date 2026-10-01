// Identity core schema: additive only. New tables and nullable columns, every
// statement idempotent, nothing dropped, altered in type, deleted or rewritten.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/db.js", import.meta.url), "utf8");
const start = src.indexOf("export async function ensureSchema");
const slice = src.slice(start, src.indexOf("_schemaEnsured = true;", start));
// Each executed statement, as written in the source.
const statements = slice.split("await q`").slice(1).map((s) => s.slice(0, s.indexOf("`")));

const ran = [];
vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings) => { ran.push(strings.join("?")); return []; },
}));

describe("identity schema (ensureSchema)", () => {
  it("creates accounts, handles and credentials if absent", () => {
    for (const t of ["accounts", "handles", "credentials"]) {
      expect(slice).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
  });

  it("enforces one live row per handle with a partial unique index", () => {
    expect(slice).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS handles_live ON handles \(handle\) WHERE released_at IS NULL/);
  });

  it("adds a nullable account_id to tokens, codes and grants", () => {
    for (const t of ["auth_tokens", "oauth_codes", "oauth_grants"]) {
      expect(slice).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS account_id TEXT\``);
    }
  });

  it("contains no destructive or rewriting verb", () => {
    expect(slice).not.toMatch(/\bDROP\b|ALTER COLUMN|\bDELETE\b|\bUPDATE\b/);
  });

  it("every CREATE statement is IF NOT EXISTS, every ALTER only adds a column if absent", () => {
    const creates = statements.filter((s) => /\bCREATE\b/.test(s));
    expect(creates.length).toBeGreaterThan(10);
    for (const s of creates) expect(s).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
    for (const s of statements.filter((x) => /\bALTER\b/.test(x))) {
      expect(s).toMatch(/^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+ \w+$/);
    }
  });

  it("runs every statement once, then caches", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    const { ensureSchema, sql } = await import("../lib/db.js");
    const q = sql();
    await ensureSchema(q);
    await ensureSchema(q);
    delete process.env.DATABASE_URL;
    expect(ran.length).toBe(statements.length);
    expect(ran.some((s) => s.includes("CREATE TABLE IF NOT EXISTS accounts"))).toBe(true);
  });
});
