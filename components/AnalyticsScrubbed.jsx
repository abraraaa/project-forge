"use client";

// components/AnalyticsScrubbed.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Analytics with the URL tidied before it leaves the device: the
// fragment is dropped (a /share link carries a trainer code there), and any
// path or query part shaped like a code is replaced. A client component
// because the layout is a server component and can't pass a function prop.
// ─────────────────────────────────────────────────────────────────────────────

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { normaliseCode } from "@/lib/trainer-code";

// A code as it is shown or pasted: 12 together, or three groups of four.
// Strict on purpose: the host and slugs like "weighted-dips" fold to 12 valid
// characters. In the path only the 12-together form counts, since a real
// route ("/diag-safe-area") can be three groups of four.
const CODE_TOGETHER = /^[0-9a-z]{12}$/i;
const CODE_GROUPED = /^[0-9a-z]{4}[\s·.-]+[0-9a-z]{4}[\s·.-]+[0-9a-z]{4}$/i;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** @param {string} part one path segment or query key/value, still encoded */
function decoded(part) {
  const s = part.replace(/\+/g, " ");
  try { return decodeURIComponent(s); } catch { return s; }
}
const inPath = (part) => {
  const s = decoded(part);
  return CODE_TOGETHER.test(s) && normaliseCode(s) !== null;
};
const inQuery = (part) => {
  const s = decoded(part);
  return (CODE_TOGETHER.test(s) || CODE_GROUPED.test(s)) && normaliseCode(s) !== null;
};

/**
 * The URL analytics may keep: no fragment, and "[code]" in place of any
 * code-shaped path segment or query part. The origin is never touched.
 * @param {string} url
 */
export function scrubUrl(url) {
  if (typeof url !== "string") return url;
  const bare = url.split("#")[0];
  const origin = bare.match(ORIGIN)?.[0] || "";
  const rest = bare.slice(origin.length);
  const q = rest.indexOf("?");
  const pathname = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q) : "";
  return origin
    + pathname.replace(/[^/]+/g, (part) => (inPath(part) ? "[code]" : part))
    + query.replace(/[^?&=;,]+/g, (part) => (inQuery(part) ? "[code]" : part));
}

/** @type {import("@vercel/analytics/next").BeforeSend} */
export const beforeSend = (event) => ({ ...event, url: scrubUrl(event.url) });
/** @type {NonNullable<React.ComponentProps<typeof SpeedInsights>["beforeSend"]>} */
export const beforeSendVitals = (data) => ({ ...data, url: scrubUrl(data.url) });

export default function AnalyticsScrubbed() {
  return (
    <>
      <Analytics beforeSend={beforeSend} />
      <SpeedInsights beforeSend={beforeSendVitals} />
    </>
  );
}
