// tests/cron-cleanup.test.js
// The cleanup cron's deletion filter must be allow-listed to KNOWN garbage.
// On 2026-07-09 the previous deny-list model ("delete anything that isn't
// meta.json/history.json") wiped every profile's credentials.json — all
// registered passkeys — the first night CRON_SECRET was configured. These
// tests pin the invariant: unknown basenames are data, not orphans.

import { describe, it, expect } from "vitest";
import { isLegacyOrphan } from "../app/api/cron/cleanup/route.js";

describe("cleanup cron — deletion is allow-listed to known legacy shapes", () => {
  it("deletes suffixed legacy meta/history blobs", () => {
    expect(isLegacyOrphan("forge/profiles/abrar/meta-aBc1Z9.json")).toBe(true);
    expect(isLegacyOrphan("forge/profiles/abrar/history-Xy77Qp.json")).toBe(true);
  });

  it("KEEPS the canonical files", () => {
    expect(isLegacyOrphan("forge/profiles/abrar/meta.json")).toBe(false);
    expect(isLegacyOrphan("forge/profiles/abrar/history.json")).toBe(false);
  });

  it("KEEPS credentials.json — the passkey store the old model deleted", () => {
    expect(isLegacyOrphan("forge/profiles/abrar/credentials.json")).toBe(false);
  });

  it("KEEPS any unknown future basename", () => {
    expect(isLegacyOrphan("forge/profiles/abrar/preferences.json")).toBe(false);
    expect(isLegacyOrphan("forge/profiles/abrar/photos/1.png")).toBe(false);
  });

  it("does not misread names that merely contain meta-/history-", () => {
    // A profile legitimately named "meta-fan" produces .../meta-fan/meta.json —
    // the basename is canonical and the regex must not match the directory.
    expect(isLegacyOrphan("forge/profiles/meta-fan/meta.json")).toBe(false);
    expect(isLegacyOrphan("forge/profiles/abrar/meta-fan/history.json")).toBe(false);
  });
});
