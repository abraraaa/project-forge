// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/use-today-iso.js
// Today's local date as state, so memos keyed on it recompute when the
// calendar day changes with the app open (a PWA left running over Sun→Mon
// otherwise keeps judging last week). Re-checked on foreground, focus, and a
// minute tick. Same-day checks keep the state, so renders stay stable.
import { useEffect, useState } from "react";
import { localDateStr } from "./dates.js";

const anchorAt = (ms) => ({ todayIso: localDateStr(new Date(ms)), nowMs: ms });

/**
 * The day, plus the moment it was first seen: `nowMs` moves only when
 * `todayIso` does, for a screen that also needs a time of day but must not
 * read the clock mid-render.
 * @returns {{ todayIso: string, nowMs: number }}
 */
export function useTodayAnchor() {
  const [anchor, setAnchor] = useState(() => anchorAt(Date.now()));
  useEffect(() => {
    const reanchor = () => setAnchor((prev) => {
      const next = anchorAt(Date.now());
      return next.todayIso === prev.todayIso ? prev : next;
    });
    document.addEventListener("visibilitychange", reanchor);
    window.addEventListener("focus", reanchor);
    const id = setInterval(reanchor, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", reanchor);
      window.removeEventListener("focus", reanchor);
      clearInterval(id);
    };
  }, []);
  return anchor;
}

export function useTodayIso() {
  return useTodayAnchor().todayIso;
}
