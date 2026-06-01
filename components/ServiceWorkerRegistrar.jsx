"use client";

// Service-worker registration boundary. Client-side because the SW API only
// exists in the browser. Renders nothing visible; lives once in app/layout.
//
// Escape hatch: append `?nosw=1` to any URL to unregister all service
// workers + clear caches. Useful while iterating, and as a panic button if
// a future SW deploy gets stuck on a user's device.

import { useEffect } from "react";

const SW_PATH = "/sw.js";

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Escape hatch — runs BEFORE any registration attempt so it can clear a
    // stuck SW even on the first paint after the kill switch is appended.
    if (new URLSearchParams(window.location.search).has("nosw")) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then(() => {
          if (typeof caches !== "undefined") {
            return caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
          }
        })
        .then(() => console.log("[sw] unregistered all + caches cleared (?nosw=1)"))
        .catch((err) => console.warn("[sw] unregister failed:", err));
      return;
    }

    navigator.serviceWorker
      .register(SW_PATH, { scope: "/" })
      .then((reg) => {
        if (process.env.NODE_ENV !== "production") {
          console.log("[sw] registered, scope:", reg.scope);
        }
      })
      .catch((err) => {
        // Registration failure is non-fatal — the app still works without
        // the SW. Surface it in the console for diagnostics.
        console.warn("[sw] registration failed:", err);
      });
  }, []);

  return null;
}
