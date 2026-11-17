import { describe, it, expect } from "vitest";
import { describeClient } from "../lib/connect-client.js";

describe("describeClient: the approval screen leads with where the code goes", () => {
  it("names a recognised AI by its host, not by its own claim", () => {
    expect(describeClient("Claude", "claude.ai")).toEqual({ kind: "known", headline: "Claude wants in", note: "Returns to claude.ai" });
    expect(describeClient("Totally Claude", "claude.ai").headline).toBe("Claude wants in");
    expect(describeClient("x", "chatgpt.com").headline).toBe("ChatGPT wants in");
  });

  it("an unrecognised host is the headline and the claimed name is only quoted", () => {
    const d = describeClient("Claude", "attacker.example.com");
    expect(d.kind).toBe("unknown");
    expect(d.headline).toBe("attacker.example.com wants in");
    expect(d.headline).not.toMatch(/Claude/);
    expect(d.note).toBe("It calls itself “Claude”. Only let it in if you started this from that app.");
  });

  it("a lookalike or subdomain is not recognised", () => {
    for (const h of ["claude.ai.evil.com", "evil-claude.ai", "x.claude.ai", "chatgpt.com.example"]) {
      expect(describeClient("Claude", h).kind, h).toBe("unknown");
    }
  });

  it("loopback reads as an app on this device, port and all", () => {
    const d = describeClient("Desktop", "127.0.0.1:33418");
    expect(d.kind).toBe("device");
    expect(d.headline).toBe("An app on this device wants in");
    expect(d.note).toBe("It calls itself “Desktop”. Returns to 127.0.0.1:33418");
    expect(describeClient("D", "[::1]:8080").kind).toBe("device");
    expect(describeClient("D", "localhost").kind).toBe("device");
  });

  it("an empty name still reads as a sentence", () => {
    expect(describeClient("", "notes.example").note).toMatch(/“an AI assistant”/);
  });
});
