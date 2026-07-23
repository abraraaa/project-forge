"use client";

// Bug report sheet — the intake half of the boss's fill-or-kill flow.
// One sheet, one scrim, bottom-row Cancel/primary (house modal doctrine,
// 2026-07-21 — no corner ✕). Submitting is open (no ceremony): friction
// kills bug reports, and the API bounds abuse with a hard rate limit +
// length cap. COPY: drafts, flagged for the intimacy pass.

import { useState } from "react";
import { T } from "@/lib/tokens";
import { fetchWithTimeout } from "@/lib/net";
import { useModalA11y } from "@/lib/a11y";

const COPY = {
  // — intimacy pass candidates (boss pass pending) —
  eyebrow: "Something off?",
  title: "Tell me where it hurts.",
  placeholder: "What happened, and where were you in the app when it did?",
  send: "Send it",
  sending: "Sending…",
  sent: "Received. It goes on the list.",
  failed: "Couldn't send — try once more?",
};

export default function BugReportSheet({ profileName = null, onClose }) {
  const [message, setMessage] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | failed
  const { containerRef, onKeyDown } = useModalA11y(onClose);

  const send = async () => {
    if (!message.trim() || state === "sending") return;
    setState("sending");
    try {
      const res = await fetchWithTimeout("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          profile: profileName || undefined,
          context: { route: typeof location !== "undefined" ? location.pathname : null },
        }),
      });
      setState(res.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <div onKeyDown={onKeyDown} onClick={onClose} className="forge-scrim" style={{ overscrollBehavior: "contain", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="bug-title" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="forge-sheet-ground" style={{ background: T.bg2, padding: "24px 24px 36px", width: "100%", borderTop: `1px solid ${T.bg3}`, animation: `slideUp 260ms ${T.ease}`, outline: "none" }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: T.text3, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>
          {COPY.eyebrow}
        </div>
        <div id="bug-title" style={{ fontFamily: T.serif, fontSize: 24, fontWeight: 300, lineHeight: 1.2, marginBottom: 16 }}>
          {COPY.title}
        </div>

        {state === "sent" ? (
          <div style={{ fontFamily: T.serif, fontSize: 15, fontStyle: "italic", fontWeight: 300, color: T.sage, marginBottom: 20 }}>
            {COPY.sent}
          </div>
        ) : (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            rows={5}
            placeholder={COPY.placeholder}
            style={{ width: "100%", background: T.bg1, border: `1px solid ${T.bg3}`, borderRadius: T.r.md, padding: "14px 16px", fontSize: 14, lineHeight: 1.5, color: T.text1, fontFamily: T.sans, resize: "none", outline: "none", marginBottom: 8 }}
          />
        )}
        {state === "failed" && (
          <div style={{ fontSize: 12, color: T.rose, marginBottom: 8 }}>{COPY.failed}</div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "16px", background: T.bg3, border: `1px solid ${T.bg4}`, borderRadius: T.r.lg, cursor: "pointer", fontSize: 14, color: T.text2 }}>
            {state === "sent" ? "Done" : "Cancel"}
          </button>
          {state !== "sent" && (
            <button onClick={send} disabled={!message.trim() || state === "sending"} style={{ flex: 2, padding: "16px", background: message.trim() ? T.coral : T.bg3, border: "none", borderRadius: T.r.lg, cursor: message.trim() ? "pointer" : "default", fontFamily: T.serif, fontSize: 17, fontWeight: 400, color: message.trim() ? T.bg0 : T.text4 }}>
              {state === "sending" ? COPY.sending : COPY.send}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
