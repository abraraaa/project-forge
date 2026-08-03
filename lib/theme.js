// lib/theme.js
// ─────────────────────────────────────────────────────────────────────────────
// Appearance override — the mode contract's manual switch. PER-PROFILE: a
// shared device keeps each person's mode, applied when their profile
// activates. Launch stays flash-free because profile resolution is itself
// just a localStorage read — the pre-paint script in app/layout.jsx reads
// forge:active, then that profile's key, before first paint.
//
// Three states: "auto" (the default — follow prefers-color-scheme; nothing
// stored, nothing stamped), "light", "dark". color-scheme is the SINGLE
// mechanism: every token in globals.css resolves through light-dark(), so
// overriding the inline color-scheme on <html> re-resolves the whole
// palette — and the inline style beats any stylesheet rule, so the UA
// canvas, form controls and scrollbars follow the same override.
//
// Key shape: forge:<profile>:theme, JSON-encoded like every other
// profile-suffixed key ("theme" is registered in PROFILE_SUFFIXES, so
// store-health recognises it and a profile wipe clears it with the rest).
// ─────────────────────────────────────────────────────────────────────────────

const themeKey = (profile) => `forge:${profile}:theme`;

/** @param {string|null|undefined} profile @returns {"auto"|"light"|"dark"} */
export function getThemePreference(profile) {
  if (!profile) return "auto";
  try {
    const t = JSON.parse(window.localStorage.getItem(themeKey(profile)) || "null");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

// Stamp the DOM. The change rides a view-transition crossfade where the
// platform offers one (motion doctrine: colour may animate) — a bare
// attribute swap repaints the whole page in one frame, which reads as a
// slam. Reduced-motion and no-VT environments get the instant swap.
// Idempotent: a stamp that changes nothing must not mint a transition
// (profile activation re-stamps on every mount).
// data-mode: the RESOLVED mode ("light"|"dark"), stamped alongside the
// color-scheme override. Exists for IMAGES ONLY (the dark-tuned substrate
// in globals.css) — background-image URLs cannot ride light-dark(), which
// is a <color> function. Every colour stays on the light-dark() axis; if
// you find yourself keying a colour off data-mode, that's the retired
// twin-block pattern coming back.
/** @param {"auto"|"light"|"dark"} pref @returns {"light"|"dark"} */
export function resolveMode(pref) {
  if (pref === "light" || pref === "dark") return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** @param {"auto"|"light"|"dark"} pref */
export function stampTheme(pref) {
  const el = document.documentElement;
  const manual = pref === "light" || pref === "dark";
  const next = manual ? pref : "light dark";
  const mode = resolveMode(pref);
  if (el.style.colorScheme === next && el.dataset.mode === mode) return;
  const mutate = () => { el.style.colorScheme = next; el.dataset.mode = mode; };
  try {
    if (document.startViewTransition &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.startViewTransition(mutate);
      return;
    }
  } catch { /* fall through to the plain swap */ }
  mutate();
}

/** @param {string|null|undefined} profile @param {"auto"|"light"|"dark"} pref */
export function applyThemePreference(profile, pref) {
  stampTheme(pref);
  if (!profile) return;
  try {
    if (pref === "light" || pref === "dark") {
      window.localStorage.setItem(themeKey(profile), JSON.stringify(pref));
    } else {
      window.localStorage.removeItem(themeKey(profile));
    }
  } catch { /* persist is best-effort; the stamp still applies */ }
}
