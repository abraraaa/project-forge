"use client";

// Auto appearance follows a live OS flip on every route, not just home. Colours
// re-resolve on their own via light-dark(); data-mode (the substrate's image
// key) needs the re-stamp. Reads the active profile at flip time, so a profile
// switch needs no resubscribe. Manual preferences ignore the event.
import { useEffect } from "react";
import { P } from "@/lib/storage";
import { getThemePreference, stampTheme } from "@/lib/theme";

export default function ThemeFollower() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onFlip = () => stampTheme(getThemePreference(P.getActive()));
    mq.addEventListener("change", onFlip);
    return () => mq.removeEventListener("change", onFlip);
  }, []);
  return null;
}
