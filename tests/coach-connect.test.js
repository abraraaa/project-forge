import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { claudeInstallUrl, CONNECT_OPTIONS, MCP_URL, ago } from "../lib/coach-connect.js";
import { NextRequest } from "next/server";
import { memoryStore } from "../lib/oauth.js";

// The connections route over the memory store, signed in as A.
const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const store = memoryStore();
vi.mock("@/lib/oauth-store", () => ({ neonOAuthStore: async () => store }));
vi.mock("@/lib/auth-server", () => ({
  readTokenData: async (t) => (t === "ok" ? { accountId: A } : null),
  resolveTokenIdentity: async (d) => (d ? { accountId: A, storageKey: "sam" } : null),
}));

describe("connect your AI", () => {
  it("Claude opens its add-connector dialog prefilled with our name and URL", () => {
    const u = new URL(claudeInstallUrl());
    expect(u.origin + u.pathname).toBe("https://claude.ai/customize/connectors");
    expect(u.searchParams.get("modal")).toBe("add-custom-connector");
    expect(u.searchParams.get("connectorName")).toBe("Heatwayve");
    expect(u.searchParams.get("connectorUrl")).toBe("https://heatwayve.app/mcp");
  });
  it("one dropdown, one button, steps for each — no list of connectors", () => {
    expect(CONNECT_OPTIONS.map((o) => o.id)).toEqual(["claude", "chatgpt", "gemini", "muse", "other"]);
    for (const o of CONNECT_OPTIONS) {
      expect(o.steps.length).toBeGreaterThan(0);
      if (o.action === "open") expect(o.href).toMatch(/^https:\/\//);
    }
    expect(MCP_URL).toBe("https://heatwayve.app/mcp");
  });
  it("last-read reads like a person", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(ago(now - 30e3, now)).toBe("just now");
    expect(ago(now - 2 * 3600e3, now)).toBe("2 hours ago");
    expect(ago(now - 3 * 86400e3, now)).toBe("3 days ago");
    expect(ago(null, now)).toBeNull();
  });
});

describe("connections endpoint", () => {
  const src = readFileSync(resolve(__dirname, "../app/api/sync/connections/route.js"), "utf8");
  it("rides the sync sign-in and never the photos scope", () => {
    expect(src).toContain('request.cookies.get("hw_sync")');
    expect(src).toContain('return !data.scope || data.scope === "sync" ? identity : null;');
  });
  it("disconnect revokes, never deletes", () => {
    expect(src).toContain('revokeGrantFor(store, identity, disconnect, Date.now(), { kind: "ai" })');
    expect(src).not.toMatch(/DELETE|del\(/);
  });
});

describe("connections list", () => {
  it("shows connected AIs only: a trainer share is never listed as an AI assistant", async () => {
    const own = { accountId: A, profile: "sam", credentialId: "k", scope: "training:read", expiresAt: null };
    await store.putGrant({ ...own, id: "g-ai", clientId: "c", clientName: "Claude", createdAt: 3, kind: "ai" });
    await store.putGrant({ ...own, id: "g-legacy", clientId: "c", createdAt: 2 }); // before the kind column
    await store.putGrant({ ...own, id: "hwg_t", clientId: "hw:trainer", scope: "trainer:read", createdAt: 1,
      kind: "trainer", resource: "https://heatwayve.app/trainer", trainerAccountId: B });
    const { GET } = await import("../app/api/sync/connections/route.js");
    const res = await GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=sam", { headers: { "x-hw-auth": "ok" } }));
    expect(res.status).toBe(200);
    const { connections } = await res.json();
    expect(connections.map((c) => [c.id, c.name])).toEqual([["g-ai", "Claude"], ["g-legacy", "AI assistant"]]);
  });
});
