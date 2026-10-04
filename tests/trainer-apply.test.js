// Applying to coach, the pure rules: what an application may hold, when an
// account may apply again, the cap, and the applicant's view of their row.
import { describe, it, expect } from "vitest";
import {
  ABOUT_MAX, LINK_MAX, QUEUE_CAP, REAPPLY_AFTER_MS, APPLY_COPY,
  cleanAbout, cleanLink, applyBlock, nextApplyAt, queueFull, applicationView,
} from "../lib/trainer-apply.js";

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

describe("cleanAbout", () => {
  it("trims, keeps inner newlines, folds CRLF", () => {
    expect(cleanAbout("  Gym in Leeds.\r\nLevel 3 PT.  ")).toEqual({ about: "Gym in Leeds.\nLevel 3 PT." });
  });
  it("needs some text", () => {
    for (const v of [undefined, null, "", "   \n ", 42, {}, ["x"]]) expect(cleanAbout(v)).toEqual({ error: APPLY_COPY.aboutMissing });
  });
  it("280 is the limit, counted as the browser counts", () => {
    expect(ABOUT_MAX).toBe(280);
    expect(cleanAbout("x".repeat(280))).toEqual({ about: "x".repeat(280) });
    expect(cleanAbout("x".repeat(281))).toEqual({ error: APPLY_COPY.aboutLong });
    // Trimmed first: padding never counts.
    expect(cleanAbout(` ${"x".repeat(280)} `)).toEqual({ about: "x".repeat(280) });
  });
  it("refuses control characters and bidi overrides", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001bb", "a‮b", "a⁦b", "a\u0085b"]) {
      expect(cleanAbout(bad)).toEqual({ error: APPLY_COPY.aboutPlain });
    }
    expect(cleanAbout("tab\there")).toEqual({ about: "tab\there" });
  });
});

describe("cleanLink", () => {
  it("is optional: absent or blank is null", () => {
    for (const v of [undefined, null, "", "   "]) expect(cleanLink(v)).toEqual({ link: null });
  });
  it("accepts https with a dotted host, as typed", () => {
    expect(cleanLink(" https://kim.example/coach?x=1 ")).toEqual({ link: "https://kim.example/coach?x=1" });
    expect(cleanLink("https://www.instagram.com/kim")).toEqual({ link: "https://www.instagram.com/kim" });
  });
  it("reads a bare host as https", () => {
    expect(cleanLink("instagram.com/kim")).toEqual({ link: "https://instagram.com/kim" });
  });
  it("refuses other schemes, credentials, bare hosts, spaces and non-strings", () => {
    for (const bad of ["http://kim.example", "javascript:alert(1)", "data:text/html,x", "ftp://kim.example",
      "https://user:pw@kim.example", "https://localhost/x", "https://kim", "https://kim .example", "kim example", 7, {}]) {
      expect(cleanLink(bad), String(bad)).toEqual({ error: APPLY_COPY.linkBad });
    }
  });
  it("200 is the limit, scheme included", () => {
    expect(LINK_MAX).toBe(200);
    const at = (n) => `https://k.example/${"a".repeat(n - "https://k.example/".length)}`;
    expect(cleanLink(at(200))).toEqual({ link: at(200) });
    expect(cleanLink(at(201))).toEqual({ error: APPLY_COPY.linkLong });
  });
});

describe("re-applying", () => {
  const row = (status, decidedAt = null) => ({ status, appliedAt: NOW - 40 * DAY, decidedAt, seenAt: null });

  it("anyone without a row may apply; a withdrawn row may be replaced at once", () => {
    expect(applyBlock(null, NOW)).toBeNull();
    expect(applyBlock(row("withdrawn", NOW - 1), NOW)).toBeNull();
  });
  it("a waiting application blocks; so does an approved one", () => {
    expect(applyBlock(row("applied"), NOW)).toEqual({ status: "applied" });
    expect(applyBlock(row("approved", NOW - 90 * DAY), NOW)).toEqual({ status: "approved" });
  });
  it("after a denial, 30 days to the millisecond", () => {
    expect(REAPPLY_AFTER_MS).toBe(30 * DAY);
    const decided = NOW - 30 * DAY;
    expect(applyBlock(row("denied", decided + 1), NOW)).toEqual({ status: "denied", nextAt: NOW + 1 });
    expect(applyBlock(row("denied", decided), NOW)).toBeNull();
    expect(nextApplyAt(row("denied", decided + 1), NOW)).toBe(NOW + 1);
    expect(nextApplyAt(row("denied", decided), NOW)).toBeNull();
    // A denial with no time on it never opens by itself.
    expect(applyBlock(row("denied"), NOW)).toEqual({ status: "denied", nextAt: null });
  });
  it("an unknown status blocks as waiting", () => {
    expect(applyBlock(row("paused"), NOW)).toEqual({ status: "applied" });
  });
});

describe("the cap", () => {
  it("pauses at 100 waiting", () => {
    expect(QUEUE_CAP).toBe(100);
    expect(queueFull(99)).toBe(false);
    expect(queueFull(100)).toBe(true);
    expect(queueFull(NaN)).toBe(true);
  });
});

describe("applicationView", () => {
  it("where it stands, never what was written", () => {
    const r = { status: "denied", appliedAt: NOW - 3 * DAY, decidedAt: NOW - DAY, seenAt: null, about: "secret", link: "https://x.example", terms: {} };
    expect(applicationView(r, NOW)).toEqual({ status: "denied", at: NOW - 3 * DAY, decidedAt: NOW - DAY, nextAt: NOW + 29 * DAY, seen: false });
    expect(applicationView({ ...r, status: "approved", seenAt: NOW }, NOW)).toEqual({ status: "approved", at: NOW - 3 * DAY, decidedAt: NOW - DAY, nextAt: null, seen: true });
  });
  it("none, or an unknown status, is null", () => {
    expect(applicationView(null, NOW)).toBeNull();
    expect(applicationView({ status: "paused", appliedAt: 1, decidedAt: null, seenAt: null }, NOW)).toBeNull();
  });
});
