// @ts-check
// What the approval screen calls a client. A client's name is its own claim
// (anyone can register one); the redirect host is where the browser hands the
// code. So the screen leads with the host unless it is one we recognise, and
// an unrecognised client's name is only ever quoted, never the headline.

/** Hosts whose AI products connect here, and the name we show for them. */
const KNOWN_HOSTS = Object.freeze(new Map([
  ["claude.ai", "Claude"],
  ["claude.com", "Claude"],
  ["chatgpt.com", "ChatGPT"],
]));

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * @param {string} name   the client's registered name
 * @param {string} host   the redirect URI's host (may carry a port)
 * @returns {{ kind: "known" | "device" | "unknown", headline: string, note: string }}
 */
export function describeClient(name, host) {
  const h = String(host || "").toLowerCase();
  const hostname = h.replace(/:\d+$/, "");
  const claimed = String(name || "").trim() || "an AI assistant";
  const known = KNOWN_HOSTS.get(hostname);
  if (known) return { kind: "known", headline: `${known} wants in`, note: `Returns to ${h}` };
  if (LOOPBACK.has(hostname)) {
    return { kind: "device", headline: "An app on this device wants in", note: `It calls itself “${claimed}”. Returns to ${h}` };
  }
  return {
    kind: "unknown",
    headline: `${h} wants in`,
    note: `It calls itself “${claimed}”. Only let it in if you started this from that app.`,
  };
}
