"use client";

// Service-worker registration boundary. Client-side because the SW API only
// exists in the browser. Renders nothing visible; lives once in app/layout.
//
// Escape hatch: append `?nosw=1` to any URL to unregister all service
// workers + clear caches. Useful while iterating, and as a panic button if
// a future SW deploy gets stuck on a user's device.
//
// Silent update: when a NEW service worker takes control of an existing tab
// (i.e. the user already had a previous SW, and we just shipped a new build),
// we schedule a `window.location.reload()` for the next moment the tab is
// hidden. Users never see a reload flash — when they next look at the tab,
// it's just on the new version. No popups, no banners.

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

    // Snapshot whether a SW already controls this page BEFORE registering.
    // If null, this is a first-time install — the upcoming controllerchange
    // fire is the first-claim, not an upgrade, and we should NOT reload.
    // If non-null, the user already had our SW; any future controllerchange
    // means a new build has activated and we should silently refresh.
    const hadControllerAtStart = navigator.serviceWorker.controller !== null;
    let reloadScheduled = false;

    const onControllerChange = () => {
      if (!hadControllerAtStart) return; // first install — not an upgrade
      if (reloadScheduled) return;
      reloadScheduled = true;

      const reloadIfHidden = () => {
        if (document.visibilityState !== "hidden") return;
        document.removeEventListener("visibilitychange", reloadIfHidden);
        window.location.reload();
      };

      if (document.visibilityState === "hidden") {
        // Already backgrounded — reload now, user sees fresh on return.
        window.location.reload();
      } else {
        // Visible — wait for the next backgrounding event, then reload silently.
        document.addEventListener("visibilitychange", reloadIfHidden);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

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

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}

