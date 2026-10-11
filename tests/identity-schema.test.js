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

  it("adds the trainer columns (the ended notice's seen time among them), the one-active-trainer index and the invite slot table", () => {
    for (const s of [
      "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trainer_terms JSONB",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS trainer_account_id TEXT",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS consent_version TEXT",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS revoked_by TEXT",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS looks JSONB",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS look_count INTEGER",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS notice_seen_at BIGINT",
      "CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_one_trainer ON oauth_grants (account_id) WHERE kind = 'trainer' AND revoked_at IS NULL",
      "CREATE INDEX IF NOT EXISTS oauth_grants_trainer ON oauth_grants (trainer_account_id) WHERE kind = 'trainer' AND revoked_at IS NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS trainer_invites_code ON trainer_invites (code_hash)",
    ]) expect(statements).toContain(s);
    const invites = statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS trainer_invites ("));
    expect(invites?.split("\n").slice(1, -1).map((l) => l.trim())).toEqual([
      "trainer_account_id TEXT PRIMARY KEY,",
      "code_hash TEXT NOT NULL,",
      "issued_at BIGINT NOT NULL,",
      "expires_at BIGINT NOT NULL,",
      "used_at BIGINT,",
      "grant_id TEXT",
    ]);
    // The access log lives on the grant row as a bounded ring, not in a table of its own.
    expect(slice).not.toMatch(/trainer_access_log|read_count/);
  });

  it("adds the applications table: one row per account, epoch-ms times, no CHECK to widen later; and the waiting index", () => {
    const apps = statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS trainer_applications ("));
    expect(apps?.split("\n").slice(1, -1).map((l) => l.trim())).toEqual([
      "account_id TEXT PRIMARY KEY,",
      "status TEXT,",
      "about TEXT,",
      "link TEXT,",
      "terms JSONB,",
      "applied_at BIGINT,",
      "decided_at BIGINT,",
      "seen_at BIGINT,",
      "created_at BIGINT",
    ]);
    expect(statements).toContain("CREATE INDEX IF NOT EXISTS trainer_applications_open ON trainer_applications (applied_at) WHERE status = 'applied'");
    expect(statements.filter((s) => /trainer_applications/.test(s))).toHaveLength(2);
  });

  it("adds the notice marks: one row per account and kind, epoch ms, no CHECK on kind", () => {
    const marks = statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS notice_marks ("));
    expect(marks?.split("\n").slice(1, -1).map((l) => l.trim())).toEqual([
      "account_id TEXT NOT NULL,",
      "kind TEXT NOT NULL,",
      "seen_at BIGINT NOT NULL,",
      "PRIMARY KEY (account_id, kind)",
    ]);
    expect(statements.filter((s) => /notice_marks/.test(s))).toHaveLength(1);
    // No events table: notices are derived from rows that already exist.
    expect(slice).not.toMatch(/CREATE TABLE IF NOT EXISTS notices\b|notice_events/);
  });

  it("adds the trainer changes table: one row per change, epoch-ms server times, no CHECK to widen later; three indexes; the grant's edit columns; a session's delivered time", () => {
    const changes = statements.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS trainer_changes ("));
    expect(changes?.split("\n").slice(1, -1).map((l) => l.trim())).toEqual([
      "id TEXT PRIMARY KEY,",
      "set_id TEXT NOT NULL,",
      "grant_id TEXT NOT NULL,",
      "profile TEXT NOT NULL,",
      "client_account_id TEXT NOT NULL,",
      "author_account_id TEXT NOT NULL,",
      "source TEXT NOT NULL,",
      "status TEXT NOT NULL,",
      "kind TEXT NOT NULL,",
      "target TEXT NOT NULL,",
      "old_value JSONB,",
      "new_value JSONB,",
      "basis JSONB,",
      "warnings JSONB,",
      "effective_from TEXT,",
      "created_at BIGINT NOT NULL,",
      "applied_at TEXT,",
      "outcome TEXT,",
      "undone_at BIGINT,",
      "undone_by TEXT,",
      "reverted_at TEXT,",
      "cleared_at BIGINT",
    ]);
    expect(changes).not.toMatch(/\bCHECK\b|\bREFERENCES\b/);
    for (const s of [
      "CREATE INDEX IF NOT EXISTS trainer_changes_profile ON trainer_changes (profile, created_at)",
      "CREATE INDEX IF NOT EXISTS trainer_changes_grant ON trainer_changes (grant_id, created_at)",
      "CREATE INDEX IF NOT EXISTS trainer_changes_client ON trainer_changes (client_account_id, created_at)",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS edits_at BIGINT",
      "ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS edits_off_at BIGINT",
      "ALTER TABLE trainer_changes ADD COLUMN IF NOT EXISTS delivered_at TEXT",
    ]) expect(statements).toContain(s);
    expect(statements.filter((s) => /trainer_changes/.test(s))).toHaveLength(5);
    expect(statements.filter((s) => /\bedits_/.test(s))).toHaveLength(2);
  });

  it("adds the meta write stamp: nullable, no default, and the statement count moves by one", () => {
    expect(statements).toContain("ALTER TABLE meta ADD COLUMN IF NOT EXISTS rev BIGINT");
    expect(statements.filter((s) => /^ALTER TABLE meta\b/.test(s))).toHaveLength(1);
    expect(statements).toHaveLength(49);
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
