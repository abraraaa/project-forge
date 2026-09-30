// components/ConsentLine.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The explicit-consent statement, rendered directly under every button that
// adds a passkey. Tapping that button is the consent (the ceremony carries a
// consent claim); nothing is ever gated on it. Copy lives in lib/consent.js.
// The consenting button points at `id` with aria-describedby, so assistive
// tech hears the statement with the button rather than after it.
// ─────────────────────────────────────────────────────────────────────────────

import { T } from "@/lib/tokens";
import Glyph from "@/components/Glyph";
import { CONSENT_COPY } from "@/lib/consent";

// The last word and the arrow wrap together, so the arrow never sits alone
// on a line at phone width.
const cut = CONSENT_COPY.link.lastIndexOf(" ");
const LINK_HEAD = CONSENT_COPY.link.slice(0, cut + 1);
const LINK_TAIL = CONSENT_COPY.link.slice(cut + 1);

/** Screen-reader-only text; the house has no utility class for it. */
const SR_ONLY = /** @type {import("react").CSSProperties} */ ({
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
});

/** @param {{ id?: string, style?: import("react").CSSProperties, line?: string }} props */
export default function ConsentLine({ id, style, line = CONSENT_COPY.line }) {
  return (
    <div style={{ fontFamily: T.text, ...style }}>
      <p id={id} style={{ fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: 0 }}>{line}</p>
      {/* Small print in ink2, not ink3: ink-3 is never used for sentences. */}
      <p style={{ fontSize: 12, color: T.ink2, lineHeight: 1.5, margin: "4px 0 0" }}>
        {CONSENT_COPY.age}{" "}
        {/* New tab: following it mid-onboarding must not drop the step. */}
        <a href={CONSENT_COPY.href} target="_blank" rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>
          {LINK_HEAD}<span style={{ whiteSpace: "nowrap" }}>{LINK_TAIL} <Glyph name="arrowRight" size={10}/></span>
          <span style={SR_ONLY}> (opens in a new tab)</span>
        </a>
      </p>
    </div>
  );
}
