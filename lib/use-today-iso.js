// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/use-today-iso.js
// Today's local date as state, so memos keyed on it recompute when the
// calendar day changes with the app open (a PWA left running over Sun→Mon
// otherwise keeps judging last week). Same triggers as HomeScreen's anchor:
// foreground, focus, and a minute tick. Same-day checks keep the string,
// so renders stay stable.
import { useEffect, useState } from "react";
import { todayLocalIso } from "./dates.js";

export function useTodayIso() {
  const [todayIso, setTodayIso] = useState(() => todayLocalIso());
  useEffect(() => {
    const reanchor = () => setTodayIso(todayLocalIso());
    document.addEventListener("visibilitychange", reanchor);
    window.addEventListener("focus", reanchor);
    const id = setInterval(reanchor, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", reanchor);
      window.removeEventListener("focus", reanchor);
      clearInterval(id);
    };
  }, []);
  return todayIso;
}
