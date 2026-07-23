"use client";

// Service-worker registration boundary. Client-side because the SW API only
// exists in the browser. Renders nothing visible; lives once in app/layout.
//
// Escape hatch: append `?nosw=1` to any URL to unregister all service
// workers + clear caches. Useful while iterating, and as a panic button if
// a future SW deploy gets stuck on a user's device.
//
// Update UX (audit #39) — still silent, now SAFE. The old flow let the new
// worker skipWaiting at install, which pruned the previous build's hashed
// bundles under a live tab (lazy-loaded old chunk → 404 → stranded page).
// Now the new worker WAITS, and we promote it only at a safe moment:
//   - the tab is hidden (user isn't looking — no mid-interaction swap), AND
//   - no live session draft exists (never swap builds mid-workout; the
//     draft self-expires in 12h, so an abandoned one defers, not blocks).
// Promotion posts SKIP_WAITING to the waiting worker; the resulting
// controllerchange reloads immediately (we're hidden), so page, worker and
// caches always move as one. Users still never see a popup or a flash —
// when they next look at the tab, it's just on the new version.
//
// Discovery: iOS PWAs can live for days without a navigation, so we also
// nudge reg.update() when the tab returns to visibility, throttled to
// once an hour — otherwise a long-lived standalone app never learns a new
// build exists.

import { useEffect } from "react";
import { P, D } from "@/lib/storage";

const SW_PATH = "/sw.js";
const UPDATE_CHECK_MS = 60 * 60 * 1000; // 1h between visibility-driven checks

// A fresh (unexpired) draft = a workout in flight. D.load self-purges
// past 12h, so this guard releases on its own worst-case.
function liveSessionDraft() {
  try {
    const profile = P.getActive();
    return !!(profile && D.load(profile));
  } catch {
    return false;
  }
}

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
    let registration = null;
    let lastUpdateCheck = Date.now();

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
        // The normal path: we only promote while hidden, so the reload
        // lands in the same hidden stint — fresh on return, never a flash.
        window.location.reload();
      } else {
        // A sibling tab promoted the worker while we're visible — defer to
        // the next backgrounding event, exactly the old behaviour.
        document.addEventListener("visibilitychange", reloadIfHidden);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // Promote a waiting worker ONLY at a safe moment. Called on every
    // hidden transition and whenever a new worker reaches "installed".
    const promoteIfSafe = () => {
      const waiting = registration?.waiting;
      if (!waiting) return;
      if (document.visibilityState !== "hidden") return;
      if (liveSessionDraft()) return; // never swap builds mid-workout
      waiting.postMessage({ type: "SKIP_WAITING" });
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        promoteIfSafe();
      } else if (Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
        // Long-lived standalone tabs never re-navigate; nudge discovery.
        lastUpdateCheck = Date.now();
        registration?.update().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    navigator.serviceWorker
      .register(SW_PATH, { scope: "/" })
      .then((reg) => {
        registration = reg;
        // A worker may already be parked in waiting from a previous visit.
        promoteIfSafe();
        reg.addEventListener("updatefound", () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener("statechange", () => {
            // "installed" with an existing controller = an update is now
            // waiting. If we're already backgrounded, promote right away.
            if (incoming.state === "installed" && navigator.serviceWorker.controller) {
              promoteIfSafe();
            }
          });
        });
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
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
