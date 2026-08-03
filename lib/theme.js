// lib/theme.js
// ─────────────────────────────────────────────────────────────────────────────
// Appearance override — the mode contract's manual switch. DEVICE-level by
// design (not per-profile): the pre-paint script in app/layout.jsx reads
// the key before any profile resolves, and a per-profile preference would
// flash the wrong mode on every launch and profile switch.
//
// Three states: "auto" (the default — follow prefers-color-scheme; nothing
// stored, no data-theme attribute), "light", "dark". Manual states stamp
// data-theme on <html> (the twin token blocks in globals.css key off it)
// AND override the inline color-scheme — the inline style beats any
// stylesheet rule, so the UA canvas, form controls and scrollbars follow
// the override too.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_KEY = "forge:theme";

/** @returns {"auto"|"light"|"dark"} */
export function getThemePreference() {
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

/** @param {"auto"|"light"|"dark"} pref */
export function applyThemePreference(pref) {
  const el = document.documentElement;
  if (pref === "light" || pref === "dark") {
    el.dataset.theme = pref;
    el.style.colorScheme = pref;
    try { window.localStorage.setItem(THEME_KEY, pref); } catch { /* persist is best-effort; the attribute still applies */ }
  } else {
    delete el.dataset.theme;
    el.style.colorScheme = "light dark";
    try { window.localStorage.removeItem(THEME_KEY); } catch { /* ditto */ }
  }
}
