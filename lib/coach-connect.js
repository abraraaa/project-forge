// @ts-check
// How each AI adds Heatwayve. Claude takes a prefilled link (its add-custom-
// connector dialog opens with our name and URL; the user confirms). The rest
// get the link to paste and the steps in their own words.
import { MCP_RESOURCE } from "./oauth.js";

export const MCP_URL = MCP_RESOURCE;

/** Claude's documented prefill: claude.com/docs/connectors (directory vs custom). */
export function claudeInstallUrl() {
  const q = new URLSearchParams({ modal: "add-custom-connector", connectorName: "Heatwayve", connectorUrl: MCP_URL });
  return `https://claude.ai/customize/connectors?${q}`;
}

/** @typedef {{ id: string, label: string, action: "open" | "copy", cta: string, href?: string, steps: string[] }} ConnectOption */

/** @type {ConnectOption[]} */
export const CONNECT_OPTIONS = [
  {
    id: "claude", label: "Claude", action: "open", cta: "Open Claude", href: claudeInstallUrl(),
    steps: ["Claude opens with Heatwayve filled in. Tap Add.", "Tap Connect, then Face ID. You're in."],
  },
  {
    id: "chatgpt", label: "ChatGPT", action: "copy", cta: "Copy the link",
    steps: [
      "In ChatGPT, open Settings and switch on Developer mode (paid plans).",
      "Under Apps or Connectors, choose Create. Paste the link, pick OAuth.",
      "Connect, then Face ID. You're in.",
    ],
  },
  {
    id: "other", label: "Another AI", action: "copy", cta: "Copy the link",
    steps: [
      "Find where your AI adds a custom connector (sometimes called an MCP server).",
      "Paste the link. Face ID does the rest.",
    ],
  },
];

/** "2 hours ago" style, for last-read times. */
export function ago(ms, now = Date.now()) {
  if (!ms) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24); return `${d} day${d === 1 ? "" : "s"} ago`;
}
