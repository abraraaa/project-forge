// @vitest-environment jsdom
// /trainer/terms: renders the owner's accepted text, never marked draft, never indexed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

import TrainerTermsPage, { metadata } from "../app/trainer/terms/page.jsx";

afterEach(cleanup);

describe("Trainer Terms page", () => {
  it("renders the Terms under a For trainers kicker, with no draft or placeholder", () => {
    render(<TrainerTermsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Trainer Terms");
    expect(screen.getByText("For trainers")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/draft|placeholder/i);
    for (const h of ["Who can be a trainer", "What you agree to", "When access ends", "Law"]) {
      expect(screen.getByRole("heading", { level: 2, name: h })).toBeTruthy();
    }
    const text = document.body.textContent;
    expect(text).toContain("You're 18 or over.");
    expect(text).toContain("Being a trainer on Heatwayve is free.");
    expect(text).toContain("as its controller");
    expect(text).toContain("Don't pass it on");
    expect(text).not.toContain("another app");
    expect(text).toContain("Your client can stop sharing at any time, and your access ends straight away.");
    expect(text).toContain("We may pause or end your trainer access if you misuse");
    expect(text).toContain("the law of England and Wales");
  });

  it("is never indexed", () => {
    expect(metadata.robots.index).toBe(false);
    expect(metadata.title).toBe("Trainer Terms");
  });

  it("is a server page, outside the sitemap", () => {
    expect(read("app/trainer/terms/page.jsx")).not.toContain('"use client"');
    expect(read("app/sitemap.js")).not.toContain("/trainer");
  });
});
