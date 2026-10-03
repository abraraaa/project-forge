// @vitest-environment jsdom
// The invite QR: an ink path inside a quiet-zoned, labelled svg.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import QrCode from "@/components/QrCode";
import { encodeQr, qrToSvgPath } from "@/lib/qr";

afterEach(cleanup);

const SHARE = "https://heatwayve.app/share#ABCD0FGH1KMN";

describe("QrCode", () => {
  it("renders one labelled image with a four-module quiet zone", () => {
    render(<QrCode text={SHARE} />);
    const svg = screen.getByRole("img", { name: "QR code for the share link" });
    const { size, modules } = encodeQr(SHARE);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${size + 8} ${size + 8}`);
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["168", "168"]);
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d")).toBe(qrToSvgPath(modules, size));
    expect(paths[0].getAttribute("transform")).toBe("translate(4 4)");
    expect(paths[0].getAttribute("fill")).toBe("#1A1512"); // dark on a light plate in both themes
    expect(svg.querySelector("rect").getAttribute("fill")).toBe("#F7F2EC"); // its own light plate, both themes
  });

  it("takes width and height", () => {
    render(<QrCode text={SHARE} width={200} height={120} />);
    const svg = screen.getByRole("img");
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["200", "120"]);
  });

  it("renders nothing without text", () => {
    const { container } = render(<QrCode text="" />);
    expect(container.innerHTML).toBe("");
  });
});
